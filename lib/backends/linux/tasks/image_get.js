/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

var Task = require('../../../task_agent/task');
var execFile = require('child_process').execFile;
var imgadm = require('../imgadm');

var ImageGetTask = module.exports = function (req) {
    Task.call(this);
    this.req = req;
    this.zpool = req.sysinfo.Zpool;
};

Task.createTask(ImageGetTask);

function start(callback) {
    var self = this;
    var params = {
        zpool: self.zpool,
        uuid: self.req.params.uuid,
        log: self.log
    };

    imgadm.getImage(params, function (error, image) {
        if (error) {
            var msg = error instanceof Error ? error.message : error;
            self.fatal('Image.get error: ' + msg);
            return;
        }
        self.progress(100);
        self.finish(image);
    });
}

ImageGetTask.setStart(start);
