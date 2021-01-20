/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2021 Joyent, Inc.
 */

/*
 *
 * Common functions that don't belong anywhese else.
 *
 */

var assert = require('assert-plus');
var execFile = require('child_process').execFile;
var fs = require('fs');

var verror = require('verror');

function modifyConfig(configPath, key, value, callback) {
    var newConfig;
    var out = [];
    var found = false;

    fs.readFile(configPath, 'utf8', function (error, data) {
        data.toString().split('\n').forEach(function (l) {
            var idx = l.indexOf('=');
            var lk = l.slice(0, idx);

            if (lk === 'overprovision_ratio') {
                found = true;
                out.push('overprovision_ratio=\''+value+'\'');
            } else {
                out.push(l);
            }
        });

        if (!found) {
            out.push('overprovision_ratio=\''+value+'\'');
        }

        newConfig = out.join('\n') + '\n';

        fs.writeFile(configPath, newConfig, 'utf8', function (writeError) {
            callback(writeError);
        });
    });
}

function provisionInProgressFile(uuidOrZonename, callback) {
    var filename = '/var/tmp/machine-provision-' + uuidOrZonename;
    fs.writeFile(filename, '', function (error) {
        return callback(error, filename);
    });
}

function ensureProvisionComplete(uuid, callback) {
    assert.uuid(uuid, 'uuid');
    assert.func(callback, 'callback');

    var expiresAt;
    var filename = '/var/tmp/machine-provision-' + uuid;
    var timeoutMinutes = 10;

    function callbackWhenComplete() {
        fs.stat(filename, function (err, stats) {
            var now;

            if (err) {
                if (err.code === 'ENOENT') {
                    // File is gone, provision is complete.
                    callback();
                    return;
                }
                // We don't know, something is wrong.
                callback(err);
                return;
            }

            // The provisioning file still exists - give it at least 10 minutes
            // from when provisioning was started to complete the provisioning
            // process.
            if (!expiresAt) {
                expiresAt = timeoutMinutes * 60 * 1000 + Number(stats.ctime);
            }

            // Check if we exceeded the timeout duration.
            now = Number(new Date());
            if (now > expiresAt) {
                // Expired, so consider provision complete and delete the file,
                // ignoring any delete error.
                fs.unlink(filename, function () {
                    callback();
                });
                return;
            }

            // Not expired yet, so try again in 1 second.
            setTimeout(callbackWhenComplete, 1 * 1000);
        });
    }

    callbackWhenComplete();
}


module.exports = {
    ensureProvisionComplete: ensureProvisionComplete,
    modifyConfig: modifyConfig,
    provisionInProgressFile: provisionInProgressFile
};
