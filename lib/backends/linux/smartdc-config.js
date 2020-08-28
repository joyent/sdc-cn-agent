/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

var fs = require('fs');
var path = require('path');

var netconfig = require('triton-netconfig');
var si = require('./sysinfo');
var VError = require('verror').VError;

function agentConfig(callback) {
    var config;
    var agentConfigPath = path.join(__dirname, '..', '..', '..', 'etc',
        'cn-agent.config.json');
    var err = null;

    try {
        config = JSON.parse(fs.readFileSync(agentConfigPath, 'utf-8'));
    } catch (e) {
        err = new VError(e, 'Could not parse agent config');
    }

    callback(err, config);
}

function sysinfo(callback) {
    si.sysInfo(null, callback);
}

function sdcConfig(callback) {
    si.getNodeConfigInfo(null, callback);
}

function _getAdminIpSysinfo(sysinfo_object, callback) {
    var adminIp = netconfig.adminIpFromSysinfo(sysinfo_object);

    if (!adminIp) {
        callback(new VError('Could not find admin IP'));
        return;
    }

    callback(null, adminIp);
}

/*
 * Also, allow callers to pass in their own sysinfo object.
 */
function getFirstAdminIp(sysinfo_object, callback) {
    if (!callback) {
        callback = sysinfo_object;
        sysinfo(function (err, sysinfoObj) {
            if (err) {
                callback(err);
                return;
            }

            _getAdminIpSysinfo(sysinfoObj, callback);
        });
        return;
    }
    _getAdminIpSysinfo(sysinfo_object, callback);
}

module.exports = {
    getFirstAdminIp: getFirstAdminIp,
    sdcConfig: sdcConfig,
    agentConfig: agentConfig,
    sysinfo: sysinfo
};
