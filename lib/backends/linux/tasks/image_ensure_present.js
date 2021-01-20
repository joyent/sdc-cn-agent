/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2021 Joyent, Inc.
 */

var assert = require('assert-plus');
var async = require('async');
var child_process = require('child_process');
var execFile = child_process.execFile;
var format = require('util').format;
var semver = require('semver');
var zfs = require('zfs').zfs;

var imgadm = require('../imgadm');
var Task = require('../../../task_agent/task');

var DEFAULT_CN_AGENT_PORT = 5309;
var REQUIRED_IMGADM_VERSION = '3.3.0';

const IMGADM = '/usr/triton/bin/imgadm';

function ImageEnsurePresentTask(req) {
    Task.call(this);
    this.req = req;
    this.zpool = req.params.zfs_storage_pool_name || req.sysinfo.Zpool;
}

Task.createTask(ImageEnsurePresentTask);


function start() {
    var self = this;

    var installed = false;
    var fullDataset;
    var params = self.req.params;
    var toImport = null;
    // XXX-mg Likely need to clean this up.  See recent comment in IMGAPI-235.
    var imgapiPeers = params.imgapiPeers;

    assert.optionalString(params.image_uuid, 'params.image_uuid');
    toImport = params.image_uuid;

    fullDataset = self.zpool + '/' + toImport;

    var importOptions = {
        uuid: toImport,
        zpool: self.zpool,
        log: self.log
    };

    async.series([
        checkExistingDataset,
        // ensureImgapiPeers,
        importImage
    ], function (err) {
        if (err) {
            self.fatal(err);
        } else {
            self.finish();
        }
    });

    // XXX-mg why not use imgadm get?
    function checkExistingDataset(cb) {
        self.log.info(
            'Checking whether zone template dataset '
            + fullDataset + ' exists on the system.');

        zfs.list(fullDataset, { type: 'all' }, function (error, fields, list) {
            if (!error && list.length) {
                self.log.info('Image already installed (' + fullDataset + ')');
                installed = true;
                cb();
            } else if (error && error.toString().match(/does not exist/)) {
                self.log.info('Image didn\'t appear to be installed');
                cb();
            } else if (error) {
                cb(error);
            }
        });
    }

    // Check if there are imgapiPeers provided and if the installed imgadm
    // version supports importing from a source
    function ensureImgapiPeers(cb) {
        if (installed || !(imgapiPeers && imgapiPeers.length)) {
            cb();
            return;
        }

        var argv = [IMGADM, '--version'];
        execFile(argv[0], argv.slice(1), function (err, stdout, stderr) {
            if (err) {
                cb(new Error(format('error checking imgadm version %s:\n'
                    + '    cmd: %s\n'
                    + '    stderr: %s',
                    toImport,
                    argv.join(' '),
                    stderr)));
                return;
            }

            var version = stdout.trim().split(' ')[1];
            if (semver.gte(version, REQUIRED_IMGADM_VERSION)) {
                var sourceUrl = format('http://%s:%s',
                    imgapiPeers[0].ip, DEFAULT_CN_AGENT_PORT);
                importOptions.source = sourceUrl;
                importOptions.zstream = true;

                self.log.info(
                    'Image ' + toImport +
                    ' will be imported from IMGAPI CN Peer at ' + sourceUrl);
            }

            cb();
        });
    }

    function importImage(cb) {
        if (installed) {
            cb();
            return;
        }

        imgadm.importImage(importOptions, function (err) {
            if (err) {
                self.log.error(err);
                cb(err);
                return;
            }
            cb();
        });
    }
}


ImageEnsurePresentTask.setStart(start);

module.exports = ImageEnsurePresentTask;
