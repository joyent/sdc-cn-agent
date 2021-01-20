/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2021 Joyent, Inc.
 */

var smartdc_config = require('../smartdc-config');
var Task = require('../../../task_agent/task');

var ServerSysinfoTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
};

Task.createTask(ServerSysinfoTask);

function start(callback) {
    var self = this;

    smartdc_config.sysinfo(function _onSysinfo(err, sysinfoObj) {
        if (err) {
            self.fatal({error: err});
            return;
        }

        self.finish({
            sysinfo: sysinfoObj
        });
    });
}

ServerSysinfoTask.setStart(start);
