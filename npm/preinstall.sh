#!/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2021 Joyent, Inc.
#

if [[ "${SDC_AGENT_SKIP_LIFECYCLE:-no}" = "yes" ]]; then
    printf 'Running during package build; skipping lifecycle script.\n' >&2
    exit 0
fi

# Refuse to install on a platform less than the supported min-platform.
MIN_PLATFORM=20151126T062538Z
case $(uname -s) in
Linux)
    # XXX this may need work to work in a container.
    platform=$(source /etc/os-release; echo $TRITON_RELEASE)
    ;;
SunOS)
    platform=$(uname -v | cut -d_ -f2)
    ;;
*)
    echo "$0: $(uname -s) is not a supported operating system" 1>&2
    exit 1
    ;;
esac

if [[ -z $platform ]]; then
    echo "$0: unable to determine the platform image" 1>&2
    exit 1
fi

if [[ $platform < $MIN_PLATFORM ]]; then
    echo "FATAL: min-platform for this agent is $MIN_PLATFORM" >&2
    exit 2
fi

exit 0
