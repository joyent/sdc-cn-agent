#! /bin/bash

#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2020 Joyent, Inc.
#

# A couple helpers for various scripts

function escape_stdin {
	if ! type -path jq >/dev/null 2>&1; then
		echo "ERROR: install jq and try again" 1>&2
		return 1
	fi
	jq -aRs . < "$script"
}

function escape {
	if ! type -path jq >/dev/null 2>&1; then
		echo "ERROR: install jq and try again" 1>&2
		return 1
	fi

	printf "%s" "$1" | jq -aRs .
}

function make_array {
	local arg=
	local out=
	local comma=

	for arg in "$@"; do
		out+=$comma$(escape "$arg")
		comma=", "
	done
	echo "[ $out ]"
}

# If $val is set, add an element.  A comma is output ahead of the element, so
# optional parameters should come last.
function optional {	# key val
	if [[ -z "$2" ]]; then
		return
	fi
	echo ", \"$1\": $(escape "$2")"
}
