/*
 * This file is part of Cockpit.
 *
 * Copyright (C) 2020 Red Hat, Inc.
 *
 * Cockpit is free software; you can redistribute it and/or modify it
 * under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation; either version 2.1 of the License, or
 * (at your option) any later version.
 *
 * Cockpit is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with Cockpit; If not, see <http://www.gnu.org/licenses/>.
 */
import cockpit from "cockpit";
import React from "react";

import type { VM } from '../../../types';
import type { BootOrderDevice } from '../../../helpers';
import type { Dialogs } from 'dialogs';

import { Button } from "@patternfly/react-core/dist/esm/components/Button";
import { Form, FormGroup } from "@patternfly/react-core/dist/esm/components/Form";
import {
    Modal, ModalBody, ModalFooter, ModalHeader
} from '@patternfly/react-core/dist/esm/components/Modal';
import { TextArea } from "@patternfly/react-core/dist/esm/components/TextArea";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput";

import { dirname } from "cockpit-path";
import { FormHelper } from 'cockpit-components-form-helper.jsx';
import { DialogsContext } from 'dialogs.jsx';
import { ModalError } from "cockpit-components-inline-notification.jsx";
import { FileAutoComplete } from "cockpit-components-file-autocomplete.jsx";

import { snapshotCreate, snapshotGetAll } from "../../../libvirtApi/snapshot.js";
import { getSortedBootOrderDevices, LIBVIRT_SYSTEM_CONNECTION } from "../../../helpers.js";
import { domainGet } from '../../../libvirtApi/domain.js';

import get_available_space_sh from "./get-available-space.sh";

const _ = cockpit.gettext;

let current_user: cockpit.UserInfo | null = null;
cockpit.user().then(user => { current_user = user });

interface DialogValues {
    name: string,
    description: string,
    memoryLocation: string,
}

type OnValueChanged = <K extends keyof DialogValues>(key: K, value: DialogValues[K]) => void;

const NameRow = ({
    onValueChanged,
    name,
    validationError,
} : {
    onValueChanged: OnValueChanged,
    name: string,
    validationError: string | undefined,
}) => {
    return (
        <FormGroup
            label={_("Name")}
            fieldId="snapshot-create-dialog-name">
            <TextInput value={name}
                validated={validationError ? "error" : "default"}
                id="snapshot-create-dialog-name"
                onChange={(_, value) => onValueChanged("name", value)} />
            <FormHelper helperTextInvalid={validationError} />
        </FormGroup>
    );
};

const DescriptionRow = ({
    onValueChanged,
    description
} : {
    onValueChanged: OnValueChanged,
    description: string,
}) => {
    return (
        <FormGroup fieldId="snapshot-create-dialog-description" label={_("Description")}>
            <TextArea value={description}
                id="snapshot-create-dialog-description"
                onChange={(_, value) => onValueChanged("description", value)}
                resizeOrientation="vertical"
            />
        </FormGroup>
    );
};

function getDefaultMemoryLocation(vm: VM) {
    // If we find an existing external snapshot, use it's memory path
    // as the default. Otherwise, try to find the primary disk and use
    // it's location. If that fails as well, use a reasonable hard
    // coded value.

    if (vm.snapshots) {
        for (const s of vm.snapshots.sort((a, b) => Number(b.creationTime) - Number(a.creationTime))) {
            if (s.memoryPath)
                return dirname(s.memoryPath);
        }
    }

    type BODWithSourceFile = BootOrderDevice & { device: { source: { file: string } } };

    function has_source_file(d: BootOrderDevice): d is BODWithSourceFile {
        return !!(d.bootOrder &&
                  d.type === "disk" &&
                  d.device.device === "disk" &&
                  d.device.type === "file" &&
                  d.device.source.file);
    }

    const devices = getSortedBootOrderDevices(vm).filter(has_source_file);
    if (devices.length > 0) {
        return dirname(devices[0].device.source.file);
    } else {
        if (vm.connectionName === LIBVIRT_SYSTEM_CONNECTION)
            return "/var/lib/libvirt/memory";
        else if (current_user)
            return current_user.home + "/.local/share/libvirt/memory";
    }

    return "";
}

const MemoryLocationRow = ({
    onValueChanged,
    memoryLocation,
    validationError,
    available,
    needed,
} : {
    onValueChanged: OnValueChanged,
    memoryLocation: string,
    validationError: string | undefined,
    available: null | number,
    needed: number,
}) => {
    let info = "";
    let info_variant: "default" | "warning" = "default";

    if (needed) {
        info = cockpit.format(_("Memory snapshot will use about $0."),
                              cockpit.format_bytes(needed));
    }
    if (available) {
        info = info + " " + cockpit.format(_("Total space available: $0."), cockpit.format_bytes(available));
        if (needed && available * 0.9 < needed)
            info_variant = "warning";
    }

    return (
        <FormGroup id="snapshot-create-dialog-memory-location" label={_("Memory state path")}>
            <FileAutoComplete
                onChange={(value: string) => onValueChanged("memoryLocation", value)}
                value={memoryLocation}
                isOptionCreatable
                onlyDirectories
                placeholder={_("Path to directory")}
                superuser="try" />
            <FormHelper helperTextInvalid={validationError}
                        helperText={info}
                        variant={validationError ? "error" : info_variant} />
        </FormGroup>
    );
};

function get_available_space(path: string, superuser: boolean, callback: (val: null | number) => void) {
    if (!path)
        callback(null);

    cockpit.script(get_available_space_sh, [path], superuser ? { superuser: "require" } : { })
            .then(output => {
                const info = JSON.parse(output);
                callback(info.free * info.unit);
            })
            .catch(() => {
                // channel has already logged the error
                callback(null);
            });
}

interface CreateSnapshotModalProps {
    idPrefix: string,
    vm: VM,
    isExternal: boolean,
}

interface CreateSnapshotModalState extends DialogValues {
    available: null | number,
    inProgress: boolean,
    dialogError?: string,
    dialogErrorDetail?: string,
}

interface ValidationError {
    name?: string;
    memory?: string;
}

export class CreateSnapshotModal extends React.Component<CreateSnapshotModalProps, CreateSnapshotModalState> {
    static contextType = DialogsContext;
    declare context: Dialogs;

    constructor(props: CreateSnapshotModalProps) {
        super(props);
        // cut off seconds, subseconds, and timezone
        const now = new Date().toISOString()
                .replace(/:[^:]*$/, '');
        const snapName = now;
        this.state = {
            name: snapName,
            description: "",
            memoryLocation: getDefaultMemoryLocation(props.vm),
            available: null,
            inProgress: false,
        };

        this.onValueChanged = this.onValueChanged.bind(this);
        this.dialogErrorSet = this.dialogErrorSet.bind(this);
        this.onValidate = this.onValidate.bind(this);
        this.onCreate = this.onCreate.bind(this);
    }

    updateAvailableSpace(path: string) {
        get_available_space(path, this.props.vm.connectionName === LIBVIRT_SYSTEM_CONNECTION,
                            val => this.setState({ available: val }));
    }

    onValueChanged<K extends keyof DialogValues>(key: K, value: DialogValues[K]) {
        this.setState({ [key]: value } as Pick<CreateSnapshotModalState, K>);
        if (key == "memoryLocation") {
            // We don't need to debounce this.  The "memoryLocation"
            // state is not changed on each keypress, but only when
            // the input is blurred.
            this.updateAvailableSpace(value);
        }
    }

    dialogErrorSet(text: string, detail: string) {
        this.setState({ dialogError: text, dialogErrorDetail: detail });
    }

    onValidate() {
        const { name, memoryLocation } = this.state;
        const { vm, isExternal } = this.props;
        const validationError: ValidationError = {};

        if (vm.snapshots && vm.snapshots.findIndex(snap => snap.name === name) > -1)
            validationError.name = _("Name already exists");
        else if (!name)
            validationError.name = _("Name can not be empty");

        if (isExternal && vm.state === "running" && !memoryLocation)
            validationError.memory = _("Memory save location can not be empty");

        return validationError;
    }

    onCreate() {
        const Dialogs = this.context;
        const { vm, isExternal } = this.props;
        const { name, description, memoryLocation } = this.state;
        const validationError = this.onValidate();

        if (!Object.keys(validationError).length) {
            this.setState({ inProgress: true });
            let mpath = null;
            if (isExternal && vm.state === "running" && memoryLocation) {
                mpath = memoryLocation;
                if (!mpath.endsWith("/"))
                    mpath = mpath + "/";
                mpath = mpath + vm.name + "." + name + ".save";
            }
            const superuser = (vm.connectionName === LIBVIRT_SYSTEM_CONNECTION);
            cockpit.spawn(["mkdir", "-p", memoryLocation], { ...(superuser ? { superuser: "require" } : { }), err: "message" })
                    .then(() =>
                        snapshotCreate({
                            vm,
                            name,
                            description,
                            isExternal,
                            memoryPath: mpath,
                        }))
                    .then(() => {
                        // VM Snapshots do not trigger any events so we have to refresh them manually
                        snapshotGetAll({ connectionName: vm.connectionName, domainPath: vm.id });
                        // Creating an external snapshot might change
                        // the disk configuration of a VM without event.
                        domainGet({ connectionName: vm.connectionName, id: vm.id });
                        Dialogs.close();
                    })
                    .catch(exc => {
                        this.setState({ inProgress: false });
                        this.dialogErrorSet(_("Snapshot failed to be created"), exc.message);
                    });
        }
    }

    componentDidMount() {
        this.updateAvailableSpace(this.state.memoryLocation);
    }

    estimateMemorySnapshotSize(vm: VM): number {
        /* According to experiments, the memory snapshot is smaller
           than the amount of RAM used by the virtual machine.

           RSS       File
           ----------------
           254 MB    145 MB
           636 MB    492 MB
           1.57 GB   1.4 GB
        */
        return (vm.rssMemory || vm.currentMemory) * 1024;
    }

    render() {
        const Dialogs = this.context;
        const { idPrefix, isExternal, vm } = this.props;
        const { name, description, memoryLocation, available } = this.state;
        const validationError = this.onValidate();

        const body = (
            <Form onSubmit={e => e.preventDefault()}>
                <NameRow name={name} validationError={validationError.name} onValueChanged={this.onValueChanged} />
                <DescriptionRow description={description} onValueChanged={this.onValueChanged} />
                {isExternal && vm.state === 'running' &&
                    <MemoryLocationRow memoryLocation={memoryLocation} onValueChanged={this.onValueChanged}
                                       validationError={validationError.memory}
                                       available={available}
                                       needed={this.estimateMemorySnapshotSize(vm)} />}
            </Form>
        );

        return (
            <Modal position="top" variant="medium" id={`${idPrefix}-modal`} isOpen onClose={Dialogs.close}>
                <ModalHeader title={_("Create snapshot")} />
                <ModalBody>
                    {this.state.dialogError &&
                        <ModalError
                            dialogError={this.state.dialogError}
                            {...this.state.dialogErrorDetail && { dialogErrorDetail: this.state.dialogErrorDetail } }
                        />
                    }
                    {body}
                </ModalBody>
                <ModalFooter>
                    <Button variant="primary" isLoading={this.state.inProgress} onClick={this.onCreate}
                            isDisabled={this.state.inProgress || Object.keys(validationError).length > 0}>
                        {_("Create")}
                    </Button>
                    <Button variant="link" onClick={Dialogs.close}>
                        {_("Cancel")}
                    </Button>
                </ModalFooter>
            </Modal>
        );
    }
}
