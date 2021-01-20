/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

const Task = require('../../../task_agent/task');
const assert = require('assert-plus');
const common = require('../common');
const fs = require('fs');
const imgadm = require('../imgadm');
const restify = require('restify');
const smartdcconfig = require('../smartdc-config');
const vasync = require('vasync');
const LinuxVmadm = require('vmadm');
const VError = require('verror');

var MachineCreateTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(MachineCreateTask);


function start(callback) {
    var self = this;

    assert.object(self.sysinfo, 'self.sysinfo');
    assert.string(self.sysinfo.Zpool, 'self.sysinfo.Zpool');
    self.req.params.zpool = self.req.params.zpool || self.sysinfo.Zpool;

    var creationGuardFilename;

    self.vmadm = new LinuxVmadm({
        uuid: self.req.params.uuid,
        log: self.log,
        req_id: self.req.req_id,
        sysinfo: self.sysinfo
    });

    vasync.waterfall([
        function (cb) {
            self.pre_check(function (error) {
                if (error) {
                    self.fatal(error.message);
                    return;
                }
                cb();
            });
        },
        function (cb) {
            smartdcconfig.getFirstAdminIp(function onGetIp(err, adminIp) {
                if (err) {
                    cb(err);
                    return;
                }

                self.adminip = adminIp;
                cb();
            });
        },
        function (cb) {
            common.provisionInProgressFile(
                self.req.params.uuid,
                function (err, filename) {
                    creationGuardFilename = filename;
                    cb();
                    return;
                });
        },
        self.ensure_dataset_present.bind(self),
        function (found, cb) {
            // The previous step (ensure..) returns a boolean indicating
            // whether the dataset was found. If that flag is set, we'll
            // run this (fetch) step and skip it if not.
            if (!found) {
                return self.fetch_dataset(cb);
            } else {
                return cb();
            }
        },
        // XXX-mg
        // self.add_firewall_rules.bind(self),
        self.create_machine.bind(self),
        function (cb) {
            fs.unlink(creationGuardFilename, function (unlinkError) {
                if (unlinkError) {
                    self.log.error(unlinkError.message);
                }
                cb();
            });
        }
    ],
    function (waterfallError) {
        var opts = {
            log: self.log,
            req_id: self.req.req_id,
            vmopts: {
                include_dni: self.req.params.include_dni === 'true'
            }
        };
        var uuid = self.req.params.uuid;

        self.vmadm.load(uuid, opts, function (loadError, machine) {
            if (waterfallError) {
                if (machine) {
                    self.fatal(waterfallError.message, null, { vm: machine });
                    return;
                } else {
                    self.fatal(waterfallError.message);
                    return;
                }
            } else {
                if (loadError) {
                    self.log.error(loadError.message);
                    self.finish();
                    return;
                }

                self.finish({ vm: machine });
            }
        });
    });
}


function pre_check(callback) {
    var self = this;

    if (!self.req.params.uuid) {
        callback(new VError({params: self.req.params},
            'Required \'uuid\' param not found'));
        return;
    }

    var uuid = self.req.params.uuid;
    var opts = {
        include_dni: true
    };

    self.vmadm.exists(uuid, opts, function existsCb(err, exists) {
        if (err) {
            callback(err);
            return;
        }
        if (exists) {
            callback(new Error('Machine ' + uuid + ' exists.'));
            return;
        }
        callback();
    });
}

function ensure_dataset_present(callback) {
    var self = this;
    var params = self.req.params;

    self.toImport = null;

    if (params.image_uuid) {
        self.toImport = params.image_uuid;
    } else if (params.disks && params.disks.length) {
        self.toImport = params.disks[0].image_uuid;
    } else {
        callback(new VError({params: params},
            'Required \'image_uuid\' param not found'));
        return;
    }

    self.log.info(
        'Checking whether image ' + self.toImport + ' exists on the system.');

    var opts = {
        log: self.log,
        uuid: self.toImport,
        zpool: self.req.params.zpool
    };

    imgadm.quickGetImage(opts, function _onGetImage(err, img) {
        if (err) {
            if (err.code === 'ImageNotInstalled') {
                self.log.info('Image ' + self.toImport + ' does not exist');
                callback(null, false);
                return;
            }

            self.log.warn('Error checking for image ' + self.toImport);
            callback(err);
            return;
        }

        assert.ok(img, 'Should have an img object');

        self.log.info('Image ' + self.toImport + ' exists');
        callback(null, true);
    });
}

function fetch_dataset(callback) {
    var self = this;

    var options = {
        uuid: self.toImport,
        zpool: self.req.params.zpool,
        log: self.log
    };
    imgadm.importImage(options, function (err) {
        if (err) {
            self.log.error(err);
            callback(err);
            return;
        }
        callback();
    });
}

function add_firewall_rules(callback) {
    var self = this;

    if (!self.req.params.firewall_rules) {
        self.log.info('No firewall_rules property in params: not adding');
        callback();
        return;
    }

    if (self.req.params.firewall_rules.length === 0) {
        self.log.info('No firewall rules to add in params');
        callback();
        return;
    }

    var fwClient = restify.createJsonClient({
        url: 'http://' + self.adminip + ':2021',
        headers: {
            'x-request-id': self.req.req_id
        }
    });

    self.log.debug('Adding firewall rules');

    vasync.each(self.req.params.firewall_rules, function (rule, cb) {
        var putOpts = {
            path: '/rules/' + rule.uuid
        };

        fwClient.put(putOpts, rule, function (err, res) {
            if (err) {
                self.log.error({ err: err, rule: rule },
                    'Error adding firewall rule');
            } else {
                self.log.info('Added firewall rule');
            }

            cb(err);
            return;
        });
    }, function (doneErr) {
        fwClient.close();

        self.log.debug('Added firewall rules');
        callback(doneErr);
        return;
    });
}

function create_machine(callback) {
    var self = this;
    var opts = {};
    var req = self.req;

    opts = req.params;
    opts.log = self.log;
    opts.req_id = req.req_id;

    self.vmadm.create(opts, function (error, info) {
        if (error) {
            return callback(error);
        }
        return callback();
    });
}

MachineCreateTask.setStart(start);

MachineCreateTask.createSteps({
    pre_check: {
        fn: pre_check,
        progress: 20,
        description: 'Pre-flight sanity check'
    },
    ensure_dataset_present: {
        fn: ensure_dataset_present,
        progress: 30,
        description: 'Checking for zone template dataset'
    },
    fetch_dataset: {
        fn: fetch_dataset,
        progress: 50,
        description: 'Fetching zone template dataset'
    },
    add_firewall_rules: {
        fn: add_firewall_rules,
        progress: 60,
        description: 'Adding firewall rules'
    },
    create_machine: {
        fn: create_machine,
        progress: 100,
        description: 'Creating machine'
    }
});
