/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2021 Joyent, Inc.
 */

// This file is the main file for the Linux cn-agent backend.

var cp = require('child_process');
var EventEmitter = require('events').EventEmitter;
var exec = cp.exec;
var execFile = cp.execFile;
var fs = require('fs');
var os = require('os');
var spawn = cp.spawn;
var util = require('util');

var assert = require('assert-plus');
var async = require('async');
var sprintf = require('sprintf').sprintf;
var vasync = require('vasync');
var verror = require('verror');
var zfs = require('zfs').zfs;
var zpool = require('zfs').zpool;

var backends_common = require('../common');
var imgadm = require('./imgadm');
var smartdc_config = require('./smartdc-config');
var si = require('./sysinfo');

// var systempages_reader = null;
// var arcstats_reader = null;


// ms to wait when zoneevent exits, before restarting
var ZONEEVENT_RESTART_INTERVAL = 30 * 1000;


var queueDefns = [
    {
        name: 'machine_creation',
        tasks: [ 'machine_create', 'machine_reprovision' ]
    },
    {
        name: 'image_import_tasks',
        tasks: [ 'image_ensure_present' ]
    },
    {
        name: 'server_tasks',
        tasks: [
            'command_execute',
            // 'server_overprovision_ratio',
            // 'server_reboot',
            'server_sysinfo'
        ]
    },
    {
        name: 'docker_tasks',
        tasks: [
            'docker_exec',
            'docker_copy',
            'docker_stats'
        ]
    },
    {
        name: 'docker_build_task',
        /**
         * `docker build` payloads, particularly those with a large range
         * of exposed ports, tend to be HUGE and negatively impact the
         * service when logged.
         */
        log_params: false,
        tasks: [
            'docker_build'
        ]
    },
    {
        name: 'server_nic_tasks',
        tasks: [
            'server_update_nics'
        ]
    },
    {
        name: 'agents_tasks',
        maxConcurrent: 1,
        tasks: [
            'agent_install',
            'agents_uninstall',
            'shutdown_cn_agent_update',
            'refresh_agents'
        ]
    },
    {
        name: 'machine_tasks',
        tasks: [
            'machine_boot',
            'machine_destroy',
            'machine_kill',
            'machine_proc',
            'machine_reboot',
            'machine_shutdown',
            'machine_update',
            'machine_update_nics',
            // 'machine_screenshot',
            'machine_create_snapshot',
            'machine_rollback_snapshot',
            'machine_delete_snapshot'
            // 'machine_migrate',
            // 'machine_migrate_receive'
        ]
    },
    {
        name: 'machine_images',
        tasks: [
            'machine_create_image'
        ]
    },
    {
        name: 'image_query',
        logging: false,
        tasks: [
            'image_get'
        ]
    },
    {
        name: 'machine_query',
        logging: false,
        tasks: [
            'machine_load',
            'machine_info'
        ]
    },
    {
        name: 'test_sleep',
        tasks: [ 'sleep' ]
    },
    {
        name: 'nop',
        tasks: [ 'nop' ]
    },
    {
        name: 'test_subtask',
        tasks: [ 'test_subtask' ]
    }
];


/**
 * 1) the sum of the disk used by the kvm VMs' zvols' volsizes
 * 2) the sum of the maximum capacity of VMs' zvols
 * 3) the sum of the quotas for kvm VMs (this space has a different usage
 *     pattern from zone's quotas)
 * 4) the sum of the quotas for non-kvm VMs
 * 5) the sum of the cores quotas for all VMs of all brands
 * 6) the sum of the disk used by images installed on the CN
 * 7) the total size of the pool
 * 8) the 'system space' which would be the total size of the pool minus
 *    the sum of the other numbers here and include things like the files
 *    in /opt, kernel dumps, and anything else written that's not part of
 *    the above.
 *
 * This calls:
 *
 *   callback(err, usage)
 *
 * where usage is an object with these properties:
 *
 *   kvm_zvol_used_bytes: 0,
 *   kvm_zvol_volsize_bytes: 0,
 *   kvm_quota_bytes: 0,
 *   kvm_quota_used_bytes: 0,
 *   zone_quota_bytes: 0,
 *   zone_quota_used_bytes: 0,
 *   cores_quota_bytes: 0,
 *   cores_quota_used_bytes: 0,
 *   installed_images_used_bytes: 0,
 *   pool_size_bytes: 0,
 *   pool_alloc_bytes: 0,
 *   system_used_bytes: 0
 *
 */
function getDiskUsage(opts, vms, callback) {
    var datasets = {};
    var usage = {
        kvm_zvol_used_bytes: 0,
        kvm_zvol_volsize_bytes: 0,
        kvm_quota_bytes: 0,
        kvm_quota_used_bytes: 0,
        zone_quota_bytes: 0,
        zone_quota_used_bytes: 0,
        cores_quota_bytes: 0,
        cores_quota_used_bytes: 0,
        installed_images_used_bytes: 0,
        pool_size_bytes: 0,
        pool_alloc_bytes: 0,
        system_used_bytes: 0
    };

    assert.object(opts.log, 'opts.log');

    function toInt(val) {
        var a = parseInt(val, 10);
        return (isNaN(a) ? 0 : a);
    }

    async.waterfall([
        function (cb) {
            zfs.get(
                null, // Look up properties for *all* datasets
                [ 'name', 'used', 'avail', 'refer', 'type', 'mountpoint',
                'quota', 'origin', 'volsize'],
                true, // Parseable
                function (geterr, props) {
                    if (geterr) {
                        cb(geterr);
                        return;
                    }

                    datasets = props;
                    cb();
            });
        },
        function (cb) {
            async.each(Object.keys(vms), function (uuid, fecb) {
                var vm = vms[uuid];

                // #1,2
                // XXX-mg if we decide to support kvm, this will need work.
                if (vm.brand === 'kvm') {
                    var devices = vm.disks;
                    var device;

                    for (var deviceIdx in devices) {
                        device = devices[deviceIdx];

                        var match = device.path;
                        var rdskpath = '/dev/zvol/rdsk/';
                        var rdskpathlen = rdskpath.length;
                        var ds = match.slice(rdskpathlen);

                        if (datasets.hasOwnProperty(ds)) {
                            usage.kvm_zvol_used_bytes +=
                                toInt(datasets[ds].used);
                            usage.kvm_zvol_volsize_bytes +=
                                toInt(datasets[ds].volsize);
                        }
                    }

                    // #3
                    if (datasets.hasOwnProperty(vm.zonepath.slice(1))) {
                        usage.kvm_quota_bytes += toInt(
                            datasets[vm.zonepath.slice(1)].quota);
                        usage.kvm_quota_used_bytes += toInt(
                            datasets[vm.zonepath.slice(1)].used);
                    }
                } else {
                    // #4
                    if (datasets.hasOwnProperty(vm.zonepath.slice(1))) {
                        usage.zone_quota_bytes += toInt(
                            datasets[vm.zonepath.slice(1)].quota);
                        usage.zone_quota_used_bytes += toInt(
                            datasets[vm.zonepath.slice(1)].used);
                    }
                }

                // #5
                var coreds = datasets[vm.zonepath.slice(1) + '/cores'] ||
                    datasets['zones/cores/' + vm.uuid];
                if (coreds) {
                    usage.cores_quota_bytes += toInt(coreds.quota);
                    usage.cores_quota_used_bytes += toInt(coreds.used);
                }

                fecb();
            }, function (error) {
                cb(error);
            });
        },
        function (cb) {
            // #6
            // Sum installed images 'used' values

            async.forEachSeries(
                Object.keys(datasets),
                onDataset,
                onDatasetsDone);

            function onDatasetsDone(err) {
                cb(err);
            }

            function onDataset(dataset, _next) {
                // Guard against us blowing up the stack (AGENT-1072)
                var next = function (err) {
                    setImmediate(function (_err) {
                        _next(_err);
                    }, err);
                };

                // Eliminate snapshots and sub-filesystems
                var UUID_RE = '([0-9a-f]{8}-[0-9a-f]{4}-' +
                              '[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-' +
                              '[0-9a-f]{12})';

                var datasetReStr = '^([^/]+)/' + UUID_RE + '$';
                var match = dataset.match(new RegExp(datasetReStr));
                if (!match) {
                    next();
                    return;
                }

                // Check if UUID corresponds to that of an installed image
                var datasetUuid = match[2];

                opts.log.trace(
                    { uuid: datasetUuid },
                    'quickGetImage');
                imgadm.quickGetImage({
                    uuid: datasetUuid,
                    log: opts.log
                }, function (err, manifest) {
                    if (err && err.code === 'ImageNotInstalled') {
                        next();
                        return;
                    } else if (err) {
                        opts.log.error({
                            uuid: datasetUuid, err: err },
                            'quickGetImage');
                        next();
                        return;
                    }

                    /*
                     * If we used "imgadm get" we might get a dummy result for
                     * a random UUID-named dataset. We can't easily tell whether
                     * it's really an image (in the Bad Old Days no metadata was
                     * really required), so if it has nothing but a uuid in its
                     * manifest, skip it.
                     *
                     * It's better to miss one or two images here (they'll still
                     * get counted against provisionable space by DAPI, just as
                     * system_used instead) than to double-count real VMs
                     * (which could make this box un-provisionable).
                     */
                    var keys = Object.keys(manifest);
                    if (keys.length === 1 && keys[0] === 'uuid') {
                        next();
                        return;
                    }

                    // Tally bytes used
                    usage.installed_images_used_bytes
                        += toInt(datasets[dataset].used);

                    next();
                });
            }
        },
        function (cb) {
            // #7
            var poolds = datasets['zones'];
            usage.pool_alloc_bytes = toInt(poolds.used);
            usage.pool_size_bytes = toInt(poolds.used) +
                toInt(poolds.available);

            // #8
            // All separated usages should be subtracted from the allocated
            // here. Anything not specifically listed is treated as 'system
            // space'.
            usage.system_used_bytes = usage.pool_alloc_bytes - (
                usage.kvm_zvol_used_bytes +
                usage.kvm_quota_used_bytes +
                usage.zone_quota_used_bytes +
                usage.cores_quota_used_bytes +
                usage.installed_images_used_bytes);

            cb();
        }
    ],
    function (error) {
        if (error) {
            opts.log.warn(error.message);
        }
        callback(null, usage);
    });
}


// getPoolSpaceStats() calls:
//
//  callback(err, spaceStats)
//
// where spaceStats looks like:
//
//  {
//      bytes_available: <number>,
//      bytes_used: <number>
//  }
//
// NOTE: this function is used by getZpoolInfo and not exported itself.
//
function getPoolSpaceStats(pool, opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');

    var log = opts.log;
    var spaceStats = {};

    zfs.get(pool, ['used', 'available'], true, function _onGet(err, props) {
        if (err) {
            log.error({err: err}, 'zfs get error');
            callback(err);
            return;
        }

        if (!props[pool]) {
            log.error({props: props},
                'XXX props returned degenerate values');
            callback(new Error('degenerate usage values returned for ' +
                'zpool ' + pool));
            return;
        }

        spaceStats = {
            bytes_available: parseInt(props[pool].available, 10),
            bytes_used: parseInt(props[pool].used, 10)
        };

        callback(null, spaceStats);
    });
}


// getZpoolInfo() calls:
//
//  callback(err, zpoolStatus)
//
// where zpoolStatus looks like:
//
//  {
//      <pool_name>: {
//          bytes_available,
//          bytes_used
//      }
//  }
//
function getZpoolInfo(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');

    var log = opts.log;
    var zpoolStatus = {};

    zpool.list(function _onZpoolList(zpoolListErr, _, lines) {
        if (zpoolListErr) {
            log.error({err: zpoolListErr}, 'zpool list error');
            callback(zpoolListErr);
            return;
        }

        vasync.forEachParallel({
            inputs: lines,
            func: function _getSpaceStats(poolinfo, cb) {
                var pool = poolinfo[0];

                getPoolSpaceStats(pool, opts, function _onSpaceStats(err, ss) {
                    if (err) {
                        cb(err);
                        return;
                    }

                    zpoolStatus[pool] = ss;
                    cb();
                });
            }
        }, function _afterSpaceStats(err) {
            callback(err, zpoolStatus);
        });
    });
}


function startZoneeventWatcher(opts, watchers) {
    var pid;

    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');

    // XXX-mg need zoneevent equivalent.
    watchers.zoneeventHandle = spawn('/usr/vm/sbin/zoneevent',
        ['-i', 'cn-agent']);
    pid = watchers.zoneeventHandle.pid;
    opts.log.info('zoneevent[' + pid + '] watcher running');

    watchers.zoneeventHandle.stdout.on('data', function _onData(data) {
        // If we cared about the data here, we'd parse it (JSON) but we just
        // care that *something* changed, not what it was so we always just
        // mark our sample dirty when we see any changes.
        opts.dirtyFn();
    });

    // stdin is not used
    watchers.zoneeventHandle.stdin.end();

    watchers.zoneeventHandle.on('exit', function _onExit(code) {
        watchers.zoneeventHandle = null;
        opts.log.warn('zoneevent[' + pid + '] watcher exited.');

        // restart the watcher in ZONEEVENT_RESTART_INTERVAL ms
        setTimeout(function _restartZoneeventWatcher() {
            startZoneeventWatcher(opts, watchers);
        }, ZONEEVENT_RESTART_INTERVAL);
    });
}


function startZoneConfigWatcher(opts, watchers) {
    var dir = '/etc/zones';

    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');

    // XXX-mg need equivalent.
    watchers.configWatchHandle = fs.watch(dir, function _onFsEvent() {
        // note: we ignore the arguments to the _onFsEvent() callback here
        // because we don't care *what* changed.
        opts.dirtyFn();
    });

    opts.log.info('Started fs.watch() for ' + dir);
}


function LinuxBackend(opts) {
    var self = this;

    self.log = opts.log;
    self.name = opts.backendName;
    self.queueDefns = queueDefns;
}


/*
 * This function grabs some basic memory usage information via kstat.  It should
 * be called like:
 *
 *     getMemoryInfo({log: log}, function _onInfo(err, data) {
 *         // data will contain several memory properties if err is not set
 *     });
 *
 * values in the data object are in bytes for maximum accuracy. Fields are:
 *
 *    availrmem_bytes
 *    arcsize_bytes (always 0 on Linux)
 *    total_bytes
 */
LinuxBackend.prototype.getMemoryInfo = function getMemoryInfo(_, callback) {
    si.getMemInfo({}, function _onMemInfoCb(err, info) {
        if (err) {
            callback(err);
            return;
        }

        var memMb = info['MiB of Memory'] || 0;
        var memFreeMb = info['MiB of Memory Free'] || 0;

        callback(null, {
            'availrmem_bytes': memFreeMb * 1024 * 1024,
            'arcsize_bytes': 0,
            'total_bytes': memMb * 1024 * 1024
        });
    });
};


/*
 * We rely on the presence of this file to detect if we are intending to run
 * the agent, which is why no_rabbit is false by default.
 */
LinuxBackend.prototype.getAgentConfig = function getAgentConfig(_, callback) {
    var self = this;

    smartdc_config.agentConfig(function (err, conf) {
        if (err) {
            self.log.error('Could not parse agent config: "%s", '
                + 'setting no_rabbit flag to false', err);
            conf = { no_rabbit: false };
        }

        callback(null, conf);
    });
};


// These just proxy to smartdc_config, ignoring the first (opts) argument
LinuxBackend.prototype.getSdcConfig = function getSdcConfig(_, callback) {
    return smartdc_config.sdcConfig(callback);
};
LinuxBackend.prototype.getSysinfo = function getSysinfo(_, callback) {
    return smartdc_config.sysinfo(callback);
};
LinuxBackend.prototype.getFirstAdminIp = function getFirstAdminIp(_, sysinfo,
    callback) {

    return smartdc_config.getFirstAdminIp(sysinfo, callback);
};

LinuxBackend.prototype.watchSysinfo = function watchSysinfo(opts, callback) {
    assert.object(opts, 'opts');
    assert.func(callback, 'callback');

    //
    // Note: This uses /tmp/.sysinfo.json which like much of SmartOS is not a
    //       promised interface. If the platform changes how sysinfo works,
    //       we'll need to rewrite this. Or at least add support for both the
    //       old and new way to detect sysinfo changes.
    //

    // XXX-mg not needed?
    // var self = this;
    // var watcher = new backends_common.SysinfoFileWatcher({
    //     callback: callback,
    //     filename: '/tmp/.sysinfo.json',
    //     log: self.log
    // });

    // watcher.watch();
};

LinuxBackend.prototype.getBootTime = function getBootTime(_, callback) {
    // sysinfo will have the 'Boot Time' cached, so we use that
    smartdc_config.sysinfo(function onSysinfo(err, sysinfo) {
        var boot_time;

        if (err) {
            callback(err);
            return;
        }

        boot_time =
            new Date(parseInt(sysinfo['Boot Time'], 10) * 1000).toISOString();

        callback(null, boot_time);
    });
};


LinuxBackend.prototype.getDiskUsage =
function _getDiskUsage(vms, _, callback) {
    var self = this;

    getDiskUsage({log: self.log}, vms, callback);
};


// opts will have:
//
//  {
//    fields: <array of field names to include in objects>,
//    log: <bunyan logger>,
//  }
LinuxBackend.prototype.loadVms = function loadVms(opts, callback) {
    // TODO: Implement me.
    callback(null, []);

    // vmadm.lookup({}, opts, function onLookup(err, vmobjs) {
    //     if (err) {
    //         callback(err);
    //         return;
    //     }

    //     callback(null, vmobjs);
    // });
};


//
// Loads information about the agents on this CN
//
// opts must contain:
//
//  serverUuid -- the UUID of the CN
//  sysinfo    -- the sysinfo object for this CN
//
// data will be loaded and callback will be called with:
//
//  callback(err, agents);
//
// where on failure `err` will be an Error object. On success, `err` will be
// null and `agents` will be an array of agents that looks like:
//
//  [
//      {
//          "image_uuid": "<image_uuid>",
//          "name": "net-agent",
//          "uuid": "<instance_uuid>",
//          "version": "2.2.0"
//      },
//      ...
//  ]
//
LinuxBackend.prototype.getAgents = function getAgents(opts, callback) {

    assert.object(opts, 'opts');
    assert.uuid(opts.serverUuid, 'opts.serverUuid');
    assert.object(opts.sysinfo, 'opts.sysinfo');

    var agents = opts.sysinfo['SDC Agents'];
    var agents_dir = '/opt/smartdc/agents/lib/node_modules';

    fs.readdir(agents_dir, function (err, files) {
        if (err) {
            callback(err);
            return;
        }
        async.each(files, function getImageAndUUID(name, cb) {
            var uuid_path = '/opt/smartdc/agents/etc/' + name;
            var uuidFileExists;
            var uuid;
            var image_uuid;

            async.series([
                function getImage(next) {
                    var fpath = agents_dir + '/' + name + '/image_uuid';

                    fs.readFile(fpath, {
                        encoding: 'utf8'
                    }, function (er2, img_uuid) {
                        if (er2) {
                            next(er2);
                            return;
                        }
                        image_uuid = img_uuid.trim();
                        next();
                    });
                },
                function agentUuidFileExists(next) {
                    fs.exists(uuid_path, function (exists) {
                        if (exists) {
                            uuidFileExists = true;
                        }
                        next();
                    });
                },
                function getUUID(next) {
                    if (!uuidFileExists) {
                        next();
                        return;
                    }
                    fs.readFile(uuid_path, {
                        encoding: 'utf8'
                    }, function (er2, agent_uuid) {
                        if (er2) {
                            next(er2);
                            return;
                        }
                        uuid = agent_uuid.trim();
                        next();
                    });
                }
            ], function seriesCb(er2, results) {
                if (er2) {
                    cb(er2);
                    return;
                }
                agents.forEach(function (a) {
                    if (a.name === name) {
                        a.image_uuid = image_uuid;
                        if (uuid) {
                            a.uuid = uuid;
                        }
                    }
                });
                cb();
            });
        }, function (er3) {
            if (er3) {
                callback(new verror.VError('Cannot get agents image versions'));
                return;
            }

            callback(null, agents);
        });
    });
};


LinuxBackend.prototype.getZpoolInfo = function _getZpoolInfo(_, callback) {
    var self = this;

    getZpoolInfo({log: self.log}, function onPoolInfo(err, info) {
        if (err) {
            callback(err);
            return;
        }
        callback(null, info);
    });

};


//
// The watchers here watch for 2 types of events:
//
//  1. /usr/vm/sbin/zoneevent for zone state changes
//  2. fs.watch() on /etc/zones for zone configuration changes
//
// if either of these events are seen, we'll call the 'dirtyFn' function
// that was passed in the opts. This will tell cn-agent to reload its data
// asap. Otherwise the change might not be noticed for up to a minute.
//
// opts will have:
//
//  {
//     dirtyFn: <function>,
//     log: <bunyan logger>
//  }
//
LinuxBackend.prototype.startWatchers = function startWatchers(opts) {
    var watchers = {};

    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.func(opts.dirtyFn, 'dirtyFn');

    // These should call opts.dirtyFn any time they decide the sample should be
    // "marked dirty" meaning that something changed and any cache might be
    // invalid. They should also restart themselves if there is a problem.

    // XXX TW: Do we need any system watchers here?
    // startZoneeventWatcher(opts, watchers);
    // startZoneConfigWatcher(opts, watchers);

    return watchers;
};


LinuxBackend.prototype.stopWatchers = function stopWatchers(_, watchers) {
    // Not implemented. If in the future we want to be able to stop the watchers
    // we started with startWatchers, we will be passed the same object we
    // returned there.
};


LinuxBackend.prototype.cleanupStaleLocks =
function cleanupStaleLocks(_, callback) {
    // AGENT-640: Ensure we clean up any stale machine creation guard
    // files, then set queues up as per usual.
    var cmd = '/usr/bin/rm -f /var/tmp/machine-creation-*';
    exec(cmd, function (err, stdout, stderr) {
        callback(err);
    });
};


module.exports = LinuxBackend;
