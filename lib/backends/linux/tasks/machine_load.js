/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2021 Joyent, Inc.
 */

const LinuxVmadm = require('vmadm');
var Task = require('../../../task_agent/task');

var MachineLoadTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(MachineLoadTask);

function start(callback) {
    var self = this;
    var opts = {
        include_dni: (self.req.params.include_dni === true ||
            self.req.params.include_dni === 'true'),
        log: self.log,
        req_id: self.req.req_id
    };
    var uuid = self.req.params.uuid;

    var vmadm = new LinuxVmadm({
        uuid: self.req.params.uuid,
        log: self.log,
        req_id: self.req.req_id,
        sysinfo: self.sysinfo
    });

    vmadm.load(uuid, opts, function (error, machine) {
        if (error) {
            var msg = error instanceof Error ? error.message : error;
            if (error.restCode) {
                self.fatal('VM.load error: ' + msg,
                    { restCode: error.restCode });
            } else {
                self.fatal('VM.load error: ' + msg);
            }
            return;
        }
        self.finish(machine);
    });
}

MachineLoadTask.setStart(start);
