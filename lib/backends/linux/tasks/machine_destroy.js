/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2021 Joyent, Inc.
 */

const LinuxVmadm = require('vmadm');
var vasync = require('vasync');

var common = require('../common');
var Task = require('../../../task_agent/task');

var MachineDestroyTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(MachineDestroyTask);

function start() {
    var self = this;
    var uuid = self.req.params.uuid;

    vasync.pipeline({
        funcs: [
            function ensureProvisionComplete(_, cb) {
                common.ensureProvisionComplete(uuid, cb);
            },
            function deleteVm(_, cb) {
                var vmadm = new LinuxVmadm({
                    uuid: self.req.params.uuid,
                    log: self.log,
                    req_id: self.req.req_id,
                    sysinfo: self.sysinfo
                });
                var vmadmOpts = {
                    include_dni: (self.req.params.include_dni === true ||
                        self.req.params.include_dni === 'true'),
                    log: self.log,
                    req_id: self.req.req_id
                };

                /* this will pass the error (if any) to _pipelineCompleted */
                vmadm.delete(uuid, vmadmOpts, cb);
            }
        ]
    }, function _pipelineComplete(err) {
        if (!err) {
            /* Success! */
            self.finish();
            return;
        }

        if (err.restCode === 'VmNotFound') {
            /*
             * The zone doesn't exist, so consider the delete a success (so
             * we're idempotent)
             */
            self.finish();
            return;
        }

        var msg = err instanceof Error ? err.message : err;
        self.fatal('delete error: ' + msg);
    });
}

MachineDestroyTask.setStart(start);
