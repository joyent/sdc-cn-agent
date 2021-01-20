/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2021 Joyent, Inc.
 */

const fs = require('fs');

const assert = require('assert-plus');

var Task = require('../../../task_agent/task');


var NETWORK_CONFIG_PATH = '/usr/triton/config/triton-networking.json';


var NicUpdateTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(NicUpdateTask);


function _getTritonNetworkingConfig() {
    return JSON.parse(fs.readFileSync(NETWORK_CONFIG_PATH));
}

function _writeTritonNetworkingConfig(netConfig) {
    fs.writeFileSync(NETWORK_CONFIG_PATH, JSON.stringify(netConfig, null, 2));
}

function start() {
    var self = this;

    assert.object(self.sysinfo, 'self.sysinfo');
    assert.arrayOfObject(self.req.params.nics, 'self.req.params.nics');

    var interfaces = self.sysinfo['Network Interfaces'] || {};
    var iNames = Object.keys(interfaces);

    if (iNames.length === 0) {
        self.log.error('No network interfaces found in sysinfo');
        self.fatal({error: 'No network interfaces found in sysinfo'});
        return;
    }

    var netConfig = _getTritonNetworkingConfig() || {};
    var configNicTags = netConfig.nictags;
    if (!Array.isArray(configNicTags) || configNicTags.length === 0) {
        self.log.error('No triton networking config nictags found');
        self.fatal({error: 'No triton networking config nictags found'});
        return;
    }
    var configNicTagByName = {};
    configNicTags.forEach(function _eachNicTagObj(nictagObj) {
        configNicTagByName[nictagObj['name']] = nictagObj;
    });

    var ifaceByMac = {};
    iNames.forEach(function _eachIface(name) {
        var iface = interfaces[name];
        ifaceByMac[iface['MAC Address']] = iface;
    });

    self.progress(20);

    var changed = false;

    self.req.params.nics.forEach(function (nic) {
        if (!nic.hasOwnProperty('nic_tags_provided')) {
            self.log.warn('nic "' + nic.mac
                + '" has no nic_tags_provided property; skipping');
            return;
        }

        var iface = ifaceByMac[nic.mac];
        if (!iface) {
            self.log.warn('nic "' + nic.mac
                + '" does not exist on the CN; skipping');
            return;
        }

        nic.nic_tags_provided.forEach(function _eachNicTag(nicTag) {
            var nicTagObj = configNicTagByName[nicTag];
            if (!nicTagObj) {
                // Add the name.
                configNicTags.push({
                    mac: nic.mac,
                    name: nicTag
                    // uuid: ?
                    // mtu: ?
                });
                changed = true;
            } else if (nicTagObj.mac !== nic.mac) {
                // Update the nic tag, the nic tag has changed interfaces.
                nicTagObj.mac = nic.mac;
                changed = true;
                delete configNicTagByName[nicTag];
            } else {
                // The nicTag is unchanged.
                delete configNicTagByName[nicTag];
            }
        });
    });

    // Any left over configNicTagByName entries need to be removed (as they no
    // longer exist).
    Object.keys(configNicTagByName).forEach(function _removeNicTag(nicTag) {
        var idx = configNicTags.indexOf(configNicTagByName[nicTag]);
        if (idx >= 0) {
            configNicTags.splice(idx, 1);
            changed = true;
        }
    });

    if (changed) {
        _writeTritonNetworkingConfig(netConfig);
    }

    self.finish();
}

NicUpdateTask.setStart(start);
