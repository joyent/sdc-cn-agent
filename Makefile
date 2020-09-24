#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2020 Joyent, Inc.
#

#
# Makefile: basic Makefile for template API service
#
# This Makefile is a template for new repos. It contains only repo-specific
# logic and uses included makefiles to supply common targets (javascriptlint,
# jsstyle, restdown, etc.), which are used by other repos as well. You may well
# need to rewrite most of this file, but you shouldn't need to touch the
# included makefiles.
#
# If you find yourself adding support for new targets that could be useful for
# other projects too, you should add these to the original versions of the
# included Makefiles (in eng.git) so that other teams can use them too.
#

#
# Files
#
DOC_FILES =		index.md
JS_FILES :=		$(shell ls *.js 2>/dev/null) \
			$(shell find bin lib test -name '*.js' 2>/dev/null)
JSL_CONF_NODE =		tools/jsl.node.conf
JSL_FILES_NODE =	$(JS_FILES)
JSSTYLE_FILES =		$(JS_FILES)
JSSTYLE_FLAGS =		-o indent=4,doxygen,unparenthesized-return=0

# The next line breaks the build due to a variable that eng.git sed expander
# doesn't know about (@@ENABLED@@)
# SMF_MANIFESTS_IN = smf/manifests/cn-agent.xml.in

NODE_PREBUILT_VERSION =	v6.17.0
NODE_PREBUILT_TAG =	gz
ifeq ($(shell uname -s),SunOS)
NODE_PREBUILT_IMAGE =	18b094b0-eb01-11e5-80c1-175dac7ddf02
endif

# Included definitions
ENGBLD_REQUIRE := $(shell git submodule update --init deps/eng)
include ./deps/eng/tools/mk/Makefile.defs
TOP ?= $(error Unable to access eng.git submodule Makefiles.)

ifeq ($(shell uname -s),SunOS)
	include ./deps/eng/tools/mk/Makefile.node_prebuilt.defs
else
	ifeq ($(shell uname -s),Linux)
	   NODE_INSTALL    ?= $(BUILD)/node
	   NODE			   ?= $(TOP)/$(NODE_INSTALL)/bin/node
	   NPM			   ?= PATH=$(TOP)/$(NODE_INSTALL)/bin:$(PATH) $(NODE) $(TOP)/$(NODE_INSTALL)/bin/npm
	   NODE_PREBUILT_TARBALL=https://us-east.manta.joyent.com/Joyent_Dev/public/bits/linuxcn/sdcnode-v8.16.1-linux-63d6e664-3f1f-11e8-aef6-a3120cf8dd9d-linuxcn-20191231T144917Z-gdd5749b.tgz
	else
		NPM=npm
		NODE=node
		NPM_EXEC=$(shell which npm)
		NODE_EXEC=$(shell which node)
	endif
endif
include ./deps/eng/tools/mk/Makefile.smf.defs

NAME :=	cn-agent
RELEASE_TARBALL :=	$(NAME)-$(STAMP).tgz
RELEASE_MANIFEST :=	$(NAME)-$(STAMP).manifest
RELSTAGEDIR :=		/tmp/$(NAME)-$(STAMP)
NODEUNIT =		$(TOP)/node_modules/.bin/nodeunit

ifeq ($(shell uname -s),SunOS)
ZFS_SNAPSHOT_TAR :=	$(TOP)/deps/zfs_snapshot_tar/zfs_snapshot_tar
NOMKNOD :=	$(TOP)/src/nomknod/nomknod.32.so \
	$(TOP)/src/nomknod/nomknod.64.so
endif

COAL ?= root@10.99.99.7


ifeq ($(shell uname -s),Linux)
NODE_EXEC	   := $(TOP)/$(NODE_INSTALL)/bin/node
NPM_EXEC	   := $(TOP)/$(NODE_INSTALL)/bin/npm

$(NODE_EXEC) $(NPM_EXEC):
	   rm -rf $(NODE_INSTALL)
	   mkdir -p $(shell dirname $(NODE_INSTALL))
	   $(CURL) -sS --fail --connect-timeout 30 $(NODE_PREBUILT_TARBALL) -o $(BUILD)/sdcnode-v8.16.1.tgz; \
	   (cd $(TOP)/$(BUILD)/ && $(TAR) xf sdcnode-v8.16.1.tgz);
endif

#
# Due to the unfortunate nature of npm, the Node Package Manager, there appears
# to be no way to assemble our dependencies without running the lifecycle
# scripts.	These lifecycle scripts should not be run except in the context of
# an agent installation or uninstallation, so we provide a magic environment
# varible to disable them here.
#
NPM_ENV =		SDC_AGENT_SKIP_LIFECYCLE=yes \
			MAKE_OVERRIDES='CTFCONVERT=/bin/true CTFMERGE=/bin/true'
RUN_NPM_INSTALL =	$(NPM_ENV) $(NPM) install

#
# Repo-specific targets
#
.PHONY: all
ifeq ($(shell uname -s),SunOS)
all: $(SMF_MANIFESTS) | $(NPM_EXEC) $(REPO_DEPS) $(ZFS_SNAPSHOT_TAR) $(NOMKNOD)
	$(RUN_NPM_INSTALL)
else
all: $(SMF_MANIFESTS) | $(NPM_EXEC) $(REPO_DEPS)
	   $(RUN_NPM_INSTALL)
endif

$(NODEUNIT): | $(NPM_EXEC)
	$(RUN_NPM_INSTALL)

#
# Unfortunately we don't have the CTF tools available during this build.  We
# stub out their execution below, but also prevent stripping the binary.
# Shipped binaries will, at least, contain DWARF.
#

ifeq ($(shell uname -s),SunOS)
$(ZFS_SNAPSHOT_TAR): deps/zfs_snapshot_tar/.git
	cd $(@D) && $(MAKE) \
		CTFCONVERT=/bin/true \
		CTFMERGE=/bin/true \
		STRIP=/bin/true \
		$(@F)
$(NOMKNOD): src/nomknod/nomknod.c src/nomknod/Makefile
	cd $(@D) && $(MAKE)

CLEAN_FILES += $(NODEUNIT) ./node_modules/tap $(NOMKNOD)
else
CLEAN_FILES += $(NODEUNIT) ./node_modules/tap
endif

DISTCLEAN_FILES += $(NAME)-*.manifest $(NAME)-*.tgz

.PHONY: test
test:
	./test/runtests

.PHONY: test-coal
test-coal:
	./tools/rsync-to coal
	ssh $(COAL) 'cd /opt/smartdc/agents/lib/node_modules/cn-agent \
		&& /opt/smartdc/agents/lib/node_modules/cn-agent/node/bin/node \
		/opt/smartdc/agents/lib/node_modules/cn-agent/node_modules/.bin/nodeunit \
		--reporter default'


ifeq ($(shell uname -s),SunOS)
CP_ZFS_SNAPSHOT_TAR=cp $(ZFS_SNAPSHOT_TAR) $(RELSTAGEDIR)/$(NAME)/lib/zfs_snapshot_tar
CP_NOMKNOD=cp $(NOMKNOD) $(RELSTAGEDIR)/$(NAME)/lib/
CP_NODE=cp -r $(TOP)/build/node $(RELSTAGEDIR)/$(NAME)
else
CP_ZFS_SNAPSHOT_TAR=echo 'Skip zfs_snapshot_tar'
CP_NOMKNOD=echo 'Skip nomknod'
cp_NODE=echo 'Skip copying node for Linux CNs'
endif

.PHONY: release
release: all deps docs $(SMF_MANIFESTS)
	@echo "Building $(RELEASE_TARBALL)"
	@mkdir -p $(RELSTAGEDIR)/$(NAME)
	cd $(TOP) && $(RUN_NPM_INSTALL)
	cp -r \
		$(TOP)/Makefile \
		$(TOP)/bin \
		$(TOP)/lib \
		$(TOP)/node_modules \
		$(TOP)/npm \
		$(TOP)/package.json \
		$(TOP)/sapi_manifests \
		$(TOP)/smf \
		$(TOP)/test \
		$(TOP)/tools \
		$(RELSTAGEDIR)/$(NAME)
	   $(CP_NODE)
	   $(CP_ZFS_SNAPSHOT_TAR)
	   $(CP_NOMKNOD)
	# Trim node
	rm -rf \
		$(RELSTAGEDIR)/$(NAME)/node/bin/npm \
		$(RELSTAGEDIR)/$(NAME)/node/lib/node_modules \
		$(RELSTAGEDIR)/$(NAME)/node/include \
		$(RELSTAGEDIR)/$(NAME)/node/share
	uuid -v4 >$(RELSTAGEDIR)/cn-agent/image_uuid
	cd $(RELSTAGEDIR) && $(TAR) -I pigz -cf $(TOP)/$(RELEASE_TARBALL) *
	cat $(TOP)/manifest.tmpl | sed \
		-e "s/UUID/$$(cat $(RELSTAGEDIR)/cn-agent/image_uuid)/" \
		-e "s/NAME/$$(json name < $(TOP)/package.json)/" \
		-e "s/VERSION/$$(json version < $(TOP)/package.json)/" \
		-e "s/DESCRIPTION/$$(json description < $(TOP)/package.json)/" \
		-e "s/BUILDSTAMP/$(STAMP)/" \
		-e "s/SIZE/$$(stat --printf="%s" $(TOP)/$(RELEASE_TARBALL))/" \
		-e "s/SHA/$$(openssl sha1 $(TOP)/$(RELEASE_TARBALL) \
		| cut -d ' ' -f2)/" \
		> $(TOP)/$(RELEASE_MANIFEST)
	@rm -rf $(RELSTAGEDIR)
	# removing build by-product in libarchive
	rm -f deps/zfs_snapshot_tar/deps/libarchive/build/autoconf/test-driver

.PHONY: publish
publish: release
	mkdir -p $(ENGBLD_BITS_DIR)/$(NAME)
	cp $(TOP)/$(RELEASE_TARBALL) $(ENGBLD_BITS_DIR)/$(NAME)/$(RELEASE_TARBALL)
	cp $(TOP)/$(RELEASE_MANIFEST) $(ENGBLD_BITS_DIR)/$(NAME)/$(RELEASE_MANIFEST)

.PHONY: dumpvar
dumpvar:
	@if [[ -z "$(VAR)" ]]; then \
		echo "error: set 'VAR' to dump a var"; \
		exit 1; \
	fi
	@echo "$(VAR) is '$($(VAR))'"

clean::
	-cd deps/zfs_snapshot_tar && $(MAKE) clobber

# Here "cutting a release" is just tagging the current commit with
# "v(package.json version)". We don't publish this to npm.
.PHONY: cutarelease
cutarelease:
	@echo "# Ensure working copy is clean."
	[[ -z `git status --short` ]]  # If this fails, the working dir is dirty.
	@echo "# Ensure have 'json' tool."
	which json 2>/dev/null 1>/dev/null
	ver=$(shell cat package.json | json version) && \
		git tag "v$$ver" && \
		git push origin "v$$ver"

include ./deps/eng/tools/mk/Makefile.deps
ifeq ($(shell uname -s),SunOS)
	include ./deps/eng/tools/mk/Makefile.node_prebuilt.targ
endif
include ./deps/eng/tools/mk/Makefile.smf.targ
include ./deps/eng/tools/mk/Makefile.targ
