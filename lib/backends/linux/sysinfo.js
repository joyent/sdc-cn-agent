/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

// This file gathers all the data required for the sysinfo command.

var cp = require('child_process');
var execFile = cp.execFile;
var fs = require('fs');
var os = require('os');

var assert = require('assert-plus');
var vasync = require('vasync');
var VError = require('verror');


var netConfig = null;


/**
 * Create a fake log object that logs to stderr (using).
 */
function createFakeLogger() {
    var log = {};
    log.trace = log.debug = log.info = log.warn = log.error = console.error;
    return log;
}


/*
 * Parse the kernel boot arguments in '/proc/cmdline'.
 */
function getBootParams() {
    var contents = String(fs.readFileSync('/proc/cmdline')).trim();
    var settings = {};
    var split;

    // Example /proc/cmdline file:
    //  boot=live console=ttyS0 console=tty0 BOOTIF=01-00-0c-29-98-da-57
    //    ip=172.16.2.174:::255.255.0.0:: rabbitmq=guest:guest:172.16.2.14:5672
    var params = contents.split(' ');

    params.forEach(function _parseCmdlineParam(param) {
        var idx = param.indexOf('=');
        if (idx === -1) {
            return;
        }
        settings[param.slice(0, idx)] =  param.slice(idx+1);
    });

    // Split the ip string into an ip address and netmask.
    if (settings.ip) {
        split = settings.ip.split(':');
        settings.admin_netmask = split[3];
        settings.admin_ip = split[0];
        delete settings.ip;
    }

    // Get the admin (boot interface) mac - which is after the '01-'.
    if (settings.BOOTIF) {
        settings.admin_mac = settings.BOOTIF.slice(3);
        delete settings.BOOTIF;
    }

    return settings;
}

function getNodeConfigInfo(opts, callback) {
    var log = opts && opts.log || createFakeLogger();
    var config = {};
    var configPath = '/usr/triton/config/node.config';

    fs.access(configPath, function _onAccessCb(accessErr) {
        if (accessErr) {
            log.debug('Unable to access config path: %s', configPath);
            // It's not an error if the config file does not exist - as the
            // CN may not have been set up yet.
            callback(null, config);
            return;
        }

        fs.readFile(configPath, function _onReadFileCb(readErr, data) {
            if (readErr) {
                log.debug('Unable to read config path: %s', configPath);
                callback(readErr, config);
                return;
            }

            var line;
            var lines = String(data).split('\n');

            for (var i = 0; i < lines.length; i++) {
                line = lines[i].trim();
                if (!line) {
                    continue;
                }

                // Example:
                //   dhcp_lease_time='2592000'
                //   sapi_domain='sapi.dingo.local'
                //   capi_client_url='http://172.16.2.12:8080'
                var match = line.match(/^(.*?)='(.*)'$/);
                if (!match) {
                    log.warn('Invalid config line - ignoring "%s"', line);
                    continue;
                }

                var name = match[1];
                var value = match[2];
                config[name] = value;
            }

            callback(null, config);
        });
    });
}

function _getTritonNetworkingConfig() {
    if (!netConfig) {
        netConfig = JSON.parse(fs.readFileSync(
            '/usr/triton/config/triton-networking.json'));
    }
    return netConfig;
}

function _getTritonRelease() {
    // Check the Triton setup file (created during `sdc-server setup`).
    var osReleaseContents = fs.readFileSync('/etc/os-release');
    var lines = String(osReleaseContents).split('\n');
    var line;
    var prefix = 'TRITON_RELEASE="';

    for (var i = 0; i < lines.length; i++) {
        line = lines[i];
        if (line.startsWith(prefix)) {
            return line.slice(prefix.length, -1);
        }
    }

    return '';
}

function getBasicInfo(opts, callback)
{
    var sysinfo = {
        'SDC Version': '7.0',
        'Hostname': os.hostname(),
        'System Type': os.platform(),
        'VM Capable': false,
        'Bhyve Capable': false,
        'HVM API': false,
        'Live Image': _getTritonRelease(),
        'Admin NIC Tag': _getTritonNetworkingConfig().admin_tag || 'admin',
        'Boot Time': Math.floor((Date.now() / 1000) - os.uptime())

        // Admin IP             (hack below)
        // SDC Agents
    };

    // Check the Triton setup file (created during `sdc-server setup`).
    try {
        var setupContents =
            fs.readFileSync('/usr/triton/config/triton-setup-state.json');
        sysinfo.Setup = JSON.parse(setupContents).complete;
    } catch (ex) {
        sysinfo.Setup = false;
        console.error('Triton setup file error: ' + ex);
    }

    getNodeConfigInfo(opts, function _onGetConfigCb(err, config) {
        if (err) {
            console.warn('unable to get node config: ', err);
            // Ignore the node config err.
            callback(null, sysinfo);
            return;
        }

        var mappings = {
            datacenter_name: 'Datacenter Name',
            dns_domain: 'DNS Domain'
        };

        Object.keys(mappings).forEach(
                function _onMappings(name) {
            if (config.hasOwnProperty(name)) {
                sysinfo[mappings[name]] = config[name];
            }
        });

        callback(null, sysinfo);
    });
}

/*
 * Gather the following sysinfo items:
 *
 * 'CPU Type'               "model name" from /proc/cpuinfo
 * 'CPU Physical Cores'     Not what you would think: # of sockets
 * 'CPU Total Cores'        Also misleading: # of threads
 * 'CPU Virtualization'     "vmx" (Intel), "svm" (AMD), or none
 */
function getCpuInfo(opts, callback)
{
    fs.readFile('/proc/cpuinfo', function readCpuInfo(err, data) {
        if (err) {
            callback(err);
            return;
        }
        var model = null;
        var sockets = {};
        var threads = 0;
        var virt = '';      // XXX-mg verify

        var nextcpu = false;
        var lines = data.asciiSlice().split('\n');
        var line;
        for (var i = 0; i < lines.length; i++) {
            line = lines[i];

            // Don't bother splitting lines that will be of no interest
            if (line === '') {
                nextcpu = false;
                continue;
            }
            if (nextcpu) {
                continue;
            }

            var lineSplit = line.split(/\s*: /);
            var key = lineSplit[0];
            var value = lineSplit[1];

            if (key === 'processor') {
                threads++;
                continue;
            }
            if (key === 'physical id') {
                sockets[value] = true;
                if (threads > 1) {
                    nextcpu = true;
                    continue;
                }
            }
            if (key === 'model name') {
                model = value;
                continue;
            }
            if (key === 'flags') {
                var flags = value.split(' ');
                if (flags.indexOf('vmx') !== -1) {
                    virt = 'vmx';
                } else if (flags.indexOf('svm') !== -1) {
                    virt = 'svm';
                }
            }
        }

        var sysinfo = {
            'CPU Type': model,
            'CPU Physical Cores': Object.keys(sockets).length,
            'CPU Total Cores': threads,
            'CPU Virtualization': virt
        };

        callback(null, sysinfo);
    });
}

/*
 * Gather the following sysinfo item:
 *
 * 'MiB of Memory'
 */
function getMemInfo(opts, callback)
{
    var sysinfo = {};

    fs.readFile('/proc/meminfo', function readMemInfo(err, data) {
        if (err) {
            callback(err);
            return;
        }
        var lines = data.asciiSlice().split('\n');
        var wantedKeys = ['MemTotal', 'MemFree'];
        var foundKeys = 0;

        var line;
        for (var i = 0; i < lines.length; i++) {
            line = lines[i];

            var lineSplit = line.split(/:\s*| /);
            var key = lineSplit[0];
            var value = lineSplit[1];
            var units = lineSplit[2];
            if (wantedKeys.indexOf(key) === -1) {
                continue;
            }
            if (key === 'MemTotal') {
                assert(units === 'kB');
                // XXX-mg SmartOS returns the value as a string.  Number OK?
                sysinfo['MiB of Memory'] = Math.floor(value / 1024);
            } else if (key === 'MemFree') {
                assert(units === 'kB');
                sysinfo['MiB of Memory Free'] = Math.floor(value / 1024);
            }

            foundKeys += 1;
            if (foundKeys === wantedKeys.length) {
                callback(null, sysinfo);
                return;
            }
        }
        callback(new VError(
            'getMemInfo: could not find MemTotal in /proc/meminfo'));
    });
}

/*
 * Gather the following info about disks for sysinfo:
 *
 *  'Disks': {                          // XXX-mg lsblk -d -J -o name,size
 *     'sdc': {'Size in GB': 447},
 *     'sdd': {'Size in GB': 447},
 *  }
 */
function getDiskInfo(opts, callback)
{
    var log = opts && opts.log || createFakeLogger();
    var sysinfo = {
        'Disks': {}
    };

    // Filter out unwanted devices.
    fs.readFile('/proc/devices', function _onReadBlockDevices(err, buf) {
        if (err) {
            log.warn('Could not read /proc/devices: %s', err);
            callback(err, sysinfo);
            return;
        }

        // Find the text marker/section we are interested in.
        var data = buf.toString();
        var blockIdx = data.indexOf('Block devices:');
        if (blockIdx === -1) {
            log.warn('Could not find "Block Devices" in /proc/devices');
            callback(null, sysinfo);
            return;
        }

        // Create the device name map.
        var devicesByMajor = {};
        var lines = data.split('\n');
        lines.map(function _onBlockLine(line) {
            var m = line.match(/^\s*(\d+)\s+(.*)$/);
            if (m) {
                devicesByMajor[m[1]] = m[2];
            }
        });

        execFile('/bin/lsblk', ['-Jbd', '-o', 'name,size,maj:min'],
            function lsBlk(blockErr, stdout, stderr) {

            if (blockErr) {
                callback(blockErr, {stdout: stdout, stderr: stderr});
                return;
            }

            var disks = JSON.parse(stdout);
            if (!disks.blockdevices) {
                callback(null, sysinfo);
                return;
            }
            disks = disks.blockdevices;

            var disk;
            for (var i = 0; i < disks.length; i++) {
                disk = disks[i];

                // Filter disks we don't want to show.
                var major = (disk['maj:min'] || '').split(':')[0];
                var device = devicesByMajor[major];
                if (device && ['loop', 'zvol'].indexOf(device) >= 0) {
                    continue;
                }

                sysinfo['Disks'][disk.name] = {
                    'Size in GB': Math.floor(disk.size / 1000000000)
                };
            }

            callback(null, sysinfo);
        });
    });
}

/*
 * Gather the following info about the system zfs pool:
 *
 * 'Zpool'              The system zpool
 * 'Zpool Disks'        The disks in that pool
 * 'Zpool Profile'      The layout (striped, raidz, etc.)
 * 'Zpool Creation'     When it was created
 * 'Zpool Size in GiB'  zfs used + available
 */
function getZpoolInfo(opts, callback)
{
    var sysinfo = {};
    // If we can't find a system pool, these will be returned.
    var errors = [];

    /*
     * There can be many pools on the system.  sysinfo is only concerned with
     * the system pool, which has a file .system_pool in the root directory of
     * the top-level dataset.
     *
     * In order to find the .system_pool file, we need to know where each
     * pool's top-level dataset is mounted.  Getting all other zfs properties
     * that we may need at the same time as we find the mount point is just
     * about free. Thus, we use one invocation of zfs(8) to get all the
     * zfs properties we may need and one invocation of zpool to get the pool
     * properties layout.
     */
    vasync.waterfall([
        function getRootDatasetProps(next) {
            var props = ['name', 'mountpoint', 'mounted', 'creation', 'used',
                'available'];
            execFile('/sbin/zfs', ['list', '-Hpo', props.join(','), '-d', '1'],
                function zfsList(err, stdout, stderr) {

                if (err) {
                    next(err);
                    return;
                }

                var dsprops = {};
                var lines = stdout.split('\n');

                var line;
                for (var i = 0; i < lines.length; i++) {
                    line = lines[i];
                    var vals = line.split('\t');
                    var pool = vals[0];
                    dsprops[pool] = {};

                    for (var prop in props) {
                        dsprops[pool][props[prop]] = vals[prop];
                    }
                }

                next(null, dsprops);
            });
        }, function selectSystemPool(dsprops, next) {
            vasync.forEachParallel({
                inputs: Object.keys(dsprops),
                func: function isSystemPool(pool, done) {
                    var props = dsprops[pool];

                    if (props.mounted !== 'yes') {
                        errors.push(new VError({props: props},
                            'top level dataset of pool ' + pool +
                            ' is not mounted: not a system pool'));
                        done();
                        return;
                    }
                    fs.access(props.mountpoint + '/.system_pool',
                        function dotSystemPoolExists(err) {

                        if (err) {
                            errors.push(new VError({props: props},
                                'top level dataset of pool ' + pool +
                                ' does not contain "/.system_pool"'));
                            done();
                            return;
                        }
                        done(null, props);
                    });
                }
            },
            function systemPoolSelection(err, results) {
                if (err) {
                    next(err);
                    return;
                }
                var syspools = [];

                var result;
                for (var i = 0; i < results.successes.length; i++) {
                    result = results.successes[i];
                    if (!result || !result.hasOwnProperty('name')) {
                        continue;
                    }

                    syspools.push(result.name);
                }

                if (syspools.length === 0) {
                    next(new VError('no system zfs pools'));
                    return;
                }
                if (syspools.length != 1) {
                    next(new VError({results: results, syspools: syspools},
                        'multiple system zfs pools'));
                    return;
                }

                var selected = dsprops[syspools[0]];
                sysinfo['Zpool'] = selected.name;
                sysinfo['Zpool Size in GiB'] = Math.floor(
                    (Number(selected.used) + Number(selected.available)) /
                    (1024 * 1024 * 1024));
                sysinfo['Zpool Creation'] = Number(selected.creation);

                next(null, selected.name);
            });
        }, function getSystemPoolProfile(pool, next) {
            cp.execFile('/sbin/zpool', ['status', pool],
                function zpoolStatus(err, stdout, stderr) {

                if (err) {
                    next(err);
                    return;
                }

                var disks = [];
                var profile = 'stripe';

                // Pool config comes after first two newlines and has two
                // newlines after it.
                var lines = stdout.split('\n\n')[1].split('\n');

                var line;
                for (var i = 0; i < lines.length; i++) {
                    line = lines[i];

                    // Skip header line and the line with pool name
                    if (!line.startsWith('\t ')) {
                        continue;
                    }

                    // We ignore the possibility of a mixture of vdev types, as
                    // that's bad idea and only allowed by zpool(8) with a force
                    // option.
                    var m = line.match(/\t +(mirror|raidz3|raidz2|raidz)-/);
                    if (m) {
                        profile = m[1];
                        continue;
                    }

                    m = line.match(/\t +([^\s]+)\s+/);
                    if (m) {
                        disks.push(m[1]);
                    }
                }

                sysinfo['Zpool Disks'] = disks;
                sysinfo['Profile'] = profile;

                next();
            });
        }],
        function getZpoolInfoDone(err) {
            // The errors array contains errors that may be helpful when no
            // system pool is found.  If a system pool was found, the oddities
            // found along the way do not matter.
            if (err && errors) {
                err = new VError.MultiError([err].concat(errors));
            }

            callback(err, sysinfo);
        });
}

/*
 * Generates network elements in sysinfo. If sysinfo already has any of these
 * elements, they are replaced or removed to reflect the current state.
 *
 * Example elements:
 *
 *  "Network Interfaces": {
 *    "igb0": {
 *      "MAC Address": "00:25:90:94:35:ac",
 *      "ip4addr": "",
 *      "Link Status": "up",
 *      "NIC Names": []
 *    },
 *    "ixgbe0": {
 *      "MAC Address": "90:e2:ba:2a:bb:e8",
 *      "ip4addr": "",
 *      "Link Status": "up",
 *      "NIC Names": []
 *    },
 *    "ixgbe1": {
 *      "MAC Address": "90:e2:ba:2a:bb:e9",
 *      "ip4addr": "",
 *      "Link Status": "up",
 *      "NIC Names": []
 *    },
 *    "aggr1": {
 *      "MAC Address": "90:e2:ba:2a:bb:e9",
 *      "ip4addr": "10.10.64.155",
 *      "Link Status": "up",
 *      "NIC Names": [
 *        "external",
 *        "internal",
 *        "sdc_underlay",
 *        "admin"
 *      ]
 *    }
 *  },
 *  "Virtual Network Interfaces": {
 *    "external0": {
 *      "MAC Address": "90:b8:d0:85:45:f8",
 *      "ip4addr": "165.225.170.229",
 *      "Link Status": "up",
 *      "Host Interface": "aggr1",
 *      "VLAN": "3105"
 *    },
 *    "sdc_underlay0": {
 *      "MAC Address": "90:b8:d0:3b:cc:06",
 *      "ip4addr": "172.24.1.14",
 *      "Link Status": "up",
 *      "Host Interface": "aggr1",
 *      "Overlay Nic Tags": [
 *        "sdc_overlay"
 *      ],
 *      "VLAN": "99"
 *    }
 *  },
 *  "Link Aggregations": {
 *    "aggr1": {
 *      "LACP mode": "active",
 *      "Interfaces": [
 *        "ixgbe1",
 *        "ixgbe0"
 *      ]
 *    }
 *  }
 *
 */
function getNetInfo(opts, callback)
{
    assert.object(opts, 'opts');
    assert.object(opts.bootParams, 'opts.bootParams');
    assert.optionalString(opts.bootParams.admin_ip, 'opts.bootParams.admin_ip');

    var adminNicTag = _getTritonNetworkingConfig().admin_tag || 'admin';
    var bootParams = opts.bootParams;

    execFile('/sbin/ip', ['-json', 'addr'], function ipA(err, stdout, stderr) {
        if (err) {
            callback(err, {'stdout': stdout, 'stderr': stderr});
            return;
        }
        var nets = JSON.parse(stdout);
        var nics = {};
        var vnics = {};
        var aggrs = {};
        var aggr_ifs = {};
        var adminip = process.env.ADMIN_IP || bootParams.admin_ip;

        // XXX-mg does not handle vlan, vxlan.  vnic and aggr are questionable.
        var net;
        for (var i = 0; i < nets.length; i++) {
            net = nets[i];
            if (net.link_type !== 'ether') {
                continue;
            }

            var isUp = (net.operstate === 'UP' ||
                (Array.isArray(net.flags) && net.flags.indexOf('UP') >= 0));

            // Create this outside of "for" loop below so that NICs with no IP
            // addresses show up.
            nics[net.ifname] = {
                'MAC Address': net.address,
                'Link Status': isUp ? 'up' : 'down',
                'ip4addr': '',
                'NIC Names': []
            };

            var addr;
            for (var j = 0; j < net.addr_info.length; j++) {
                addr = net.addr_info[j];
                // XXX-mg what about inet6?
                if (addr.family !== 'inet') {
                    continue;
                }

                var nic;
                if (addr.label === net.ifname) {
                    // Primary IP on a nic
                    nic = nics[net.ifname];
                    nic.ip4addr = addr.local;
                } else {
                    // Vitual IP.
                    // Needs to not be a vnic because vnics lack nic tags.
                    nic = {
                        'MAC Address': net.address,
                        'Link Status': isUp ? 'up' : 'down',
                        'ip4addr': addr.local,
                        'NIC Names': []
                    };
                    nics[addr.label] = nic;
                }

                // Add the admin NIC tag.
                if (adminip && adminip === addr.local) {
                    nic['NIC Names'].push(adminNicTag);
                // Add nic tag if it exists and is not already added.
                } else if (addr.label &&
                        nic['NIC Names'].indexOf(addr.label) === -1) {
                    nic['NIC Names'].push(addr.label);
                }
            }

            // Handle "link aggregation" (bond) lower links.  Order of keys in
            // 'ip a' output is not documented to have bond slave (lower link)
            // interfaces before master (bond, aggr) interfaces so stash the
            // mapping in a separate object for now.
            if (net.hasOwnProperty('master') && net.master != '') {
                if (!aggr_ifs.hasOwnProperty(net.master)) {
                    aggr_ifs[net.master] = [];
                }
                aggr_ifs[net.master].push(net.ifname);
            }

            // Handle bond master links.
            if (net.flags.indexOf('MASTER') !== -1) {
                aggrs[net.ifname] = {
                    'LACP mode': 'Unknown' // XXX-mg fix this
                };
            }
        }

        // Add slave links to master
        for (var aggr in aggrs) {
            aggrs[aggr]['Interfaces'] = aggr_ifs[aggr] || [];
        }

        var sysinfo = {
            'Network Interfaces': nics,
            'Virtual Network Interfaces': vnics,
            'Link Aggregations': aggrs
        };
        if (adminip) {
            sysinfo['Admin IP'] = adminip;
        }

        callback(null, sysinfo);
    });
}

function getSmbiosInfo(opts, callback)
{
    execFile('/usr/sbin/dmidecode', ['-t', '1'],
        function dmiDecode(err, stdout, stderr) {

        if (err) {
            callback(err, {stdout: stdout, stderr: stderr});
            return;
        }

        // To match SmartOS smbios output
        var xlate = {
            'Family': 'HW_Family',
            'Manufacturer': 'Manufacturer',
            'Product Name': 'Product',
            'Serial Number': 'Serial_Number',
            'SKU Number': 'SKU_Number',
            // XXX-mg what's the deal with Fixed_UUID in SmartOS?
            'UUID': 'UUID',
            'Version': 'HW_Version'
        };

        var sysinfo = {};
        var lines = stdout.split(/\n\s*/);
        var line;
        for (var i = 0; i < lines.length; i++) {
            line = lines[i];
            var lineSplit = line.split(/: /, 1);
            var key = lineSplit[0];
            if (xlate.hasOwnProperty(key)) {
                sysinfo[xlate[key]] = line.slice(key.length + 2);
            }
        }
        if (sysinfo['UUID']) {
            sysinfo['UUID'] = sysinfo['UUID'].toLowerCase();
        }

        callback(null, sysinfo);
    });
}

function sysInfo(log, callback)
{
    log = log || createFakeLogger();

    var bootParams = getBootParams();

    vasync.forEachParallel({
        'inputs': [
            getBasicInfo,
            getCpuInfo,
            getMemInfo,
            getDiskInfo,
            getZpoolInfo,
            getNetInfo,
            getSmbiosInfo
        ],
        'func': function callInfoFunc(func, cb) {
            // Do not blow up when something goes wrong.  Return as many results
            // as possible.  The caller can decide whether errors are fatal.
            try {
                func({log: log, bootParams: bootParams}, cb);
            } catch (error) {
                cb(error);
            }
        }
    }, function sysinfoDone(err, results) {
        var sysinfo = {
            'Boot Params': bootParams
        };

        var frag;
        for (var i = 0; i < results.successes.length; i++) {
            frag = results.successes[i];
            if (frag) {
                Object.assign(sysinfo, frag);
            }
        }
        callback(err, sysinfo);
    });
}

module.exports = {
    sysInfo: sysInfo,
    getBasicInfo: getBasicInfo,
    getCpuInfo: getCpuInfo,
    getMemInfo: getMemInfo,
    getDiskInfo: getDiskInfo,
    getZpoolInfo: getZpoolInfo,
    getNetInfo: getNetInfo,
    getNodeConfigInfo: getNodeConfigInfo,
    getSmbiosInfo: getSmbiosInfo
};
