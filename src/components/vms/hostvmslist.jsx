/*
 * This file is part of Cockpit.
 *
 * Copyright (C) 2016 Red Hat, Inc.
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
import React, { useState } from 'react';
import PropTypes from 'prop-types';
import cockpit from 'cockpit';

import { Button } from "@patternfly/react-core/dist/esm/components/Button";
import { Card, CardHeader, CardTitle } from '@patternfly/react-core/dist/esm/components/Card';
import { Divider } from "@patternfly/react-core/dist/esm/components/Divider";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput";
import { Gallery } from "@patternfly/react-core/dist/esm/layouts/Gallery";
import { Toolbar, ToolbarContent, ToolbarItem } from "@patternfly/react-core/dist/esm/components/Toolbar";
import { Select, SelectList, SelectOption } from "@patternfly/react-core/dist/esm/components/Select";
import { MenuToggle } from "@patternfly/react-core/dist/esm/components/MenuToggle";
import { Page, PageSection } from "@patternfly/react-core/dist/esm/components/Page";
import { WithDialogs } from 'dialogs.jsx';

import VmActions from '../vm/vmActions.jsx';
import { updateVm } from '../../actions/store-actions.js';

import { vmId, rephraseUI, dummyVmsFilter, DOMAINSTATE } from "../../helpers.js";

import { ListingTable } from "cockpit-components-table.jsx";
import StateIcon from '../common/stateIcon.jsx';
import { VmNeedsShutdown } from '../common/needsShutdown.jsx';
import { VmUsesSpice } from '../vm/usesSpice.jsx';
import { AggregateStatusCards } from "../aggregateStatusCards.jsx";
import store from "../../store.js";

import "./hostvmslist.scss";

const VmState = ({ vm, vms, dismissError }) => {
    let state = null;

    if (vm.downloadProgress) {
        state = cockpit.format(_("Downloading: $0%"), vm.downloadProgress);
    } else if (vm.createInProgress) {
        state = _("Creating VM");
    } else {
        state = vm.state;
    }

    return (
        <StateIcon dismissError={dismissError}
            error={vm.error}
            state={state}
            valueId={`${vmId(vm.name)}-${vm.connectionName}-state`}
            additionalState={<><VmNeedsShutdown vm={vm} /><VmUsesSpice vm={vm} vms={vms} /></>} />
    );
};

const _ = cockpit.gettext;

/**
 * List of all VMs defined on this host
 */
const HostVmsList = ({ vms, config, ui, storagePools, actions, networks, onAddErrorNotification }) => {
    const [statusSelected, setStatusSelected] = useState({ value: _("All") });
    const [currentTextFilter, setCurrentTextFilter] = useState("");
    const [statusIsExpanded, setStatusIsExpanded] = useState(false);
    const combinedVms = [...vms, ...dummyVmsFilter(vms, ui.vms)];
    const combinedVmsFiltered = combinedVms
            // searching VM should be case insensitive
            .filter(vm => vm.name.toUpperCase().indexOf(currentTextFilter.toUpperCase()) != -1 && (!statusSelected.apiState || statusSelected.apiState == vm.state));

    const sortFunction = (vmA, vmB) => vmA.name.localeCompare(vmB.name);

    let domainStates = DOMAINSTATE.filter(state => vms.some(vm => vm.state === state));
    const prioritySorting = { // Put running, shut off and divider at top of the list. The lower the value, the bigger priority it has
        running: -3,
        "shut off": -2,
        _divider: -1,
    };
    if (domainStates.some(e => ["running", "shut off"].includes(e)) && domainStates.some(e => !["running", "shut off"].includes(e)))
        domainStates = domainStates.concat(["_divider"]);
    const sortOptions = [{ value: _("All") }]
            .concat(domainStates
                    .map(state => { return { value: rephraseUI('resourceStates', state), apiState: state } })
                    .sort((a, b) => (prioritySorting[a.apiState] || 0) - (prioritySorting[b.apiState] || 0) || a.value.localeCompare(b.value)));

    const toggle = toggleRef => (
        <MenuToggle
            ref={toggleRef}
            id="vm-state-select-toggle"
            onClick={() => setStatusIsExpanded(!statusIsExpanded)}
            isExpanded={statusIsExpanded}
            isFullWidth
        >
            {statusSelected.value}
        </MenuToggle>);

    const toolBar = (
        <Toolbar>
            <ToolbarContent>
                <ToolbarItem alignSelf="baseline">
                    <TextInput name="text-search" id="text-search" type="search"
                    value={currentTextFilter}
                    onChange={(_, currentTextFilter) => setCurrentTextFilter(currentTextFilter)}
                    placeholder={_("Filter by name")} />
                </ToolbarItem>
                {domainStates.length > 1 && <>
                    <ToolbarItem alignSelf="baseline" variant="label" id="vm-state-select">
                        {_("State")}
                    </ToolbarItem>
                    <ToolbarItem alignSelf="baseline">
                        <Select
                          id="vm-state-menu"
                          isOpen={statusIsExpanded}
                          selected={statusSelected}
                          toggle={toggle}
                          onOpenChange={isOpen => setStatusIsExpanded(isOpen)}
                          onSelect={(_, selection) => { setStatusIsExpanded(false); setStatusSelected(selection) }}
                          aria-labelledby="vm-state-select"
                        >
                            <SelectList>
                                {sortOptions.map((option, index) => (
                                    option.apiState === "_divider"
                                        ? <Divider component="li" key={index} />
                                        : <SelectOption key={index} value={option}>{option.value}</SelectOption>
                                ))}
                            </SelectList>
                        </Select>
                    </ToolbarItem>
                </>}
                <ToolbarItem alignSelf="baseline" variant="separator" />
                <ToolbarItem alignSelf="baseline">{actions}</ToolbarItem>
            </ToolbarContent>
        </Toolbar>
    );

    return (
        <WithDialogs key="vms-list">
            <Page className="no-masthead-sidebar">
                <PageSection hasBodyWrapper={false}>
                    <Gallery className="ct-cards-grid" hasGutter>
                        <AggregateStatusCards networks={networks} storagePools={storagePools} />
                        <Card isPlain id='virtual-machines-listing'>
                            <CardHeader actions={{ actions: toolBar }}>
                                <CardTitle component="h2">{_("Virtual machines")}</CardTitle>
                            </CardHeader>
                            <ListingTable aria-label={_("Virtual machines")}
                                variant='compact'
                                columns={[
                                    { title: _("Name"), header: true, props: { width: 25 } },
                                    { title: _("Connection"), props: { width: 25 } },
                                    { title: _("State"), props: { width: 25 } },
                                    { title: "", props: { width: 25, "aria-label": _("Actions") } },
                                ]}
                                emptyCaption={_("No VM is running or defined on this host")}
                                rows={ combinedVmsFiltered
                                        .sort(sortFunction)
                                        .map(vm => {
                                            const vmActions = (
                                                <VmActions
                                                vm={vm}
                                                vms={vms}
                                                config={config}
                                                storagePools={storagePools}
                                                onAddErrorNotification={onAddErrorNotification}
                                                />
                                            );

                                            return {
                                                columns: [
                                                    {
                                                        title: <Button id={`${vmId(vm.name)}-${vm.connectionName}-name`}
                                                              variant="link"
                                                              isInline
                                                              isDisabled={vm.isUi && !vm.createInProgress}
                                                              component="a"
                                                              href={'#' + cockpit.format("vm?name=$0&connection=$1", encodeURIComponent(vm.name), vm.connectionName)}
                                                              className="vm-list-item-name">{vm.name}</Button>
                                                    },
                                                    { title: rephraseUI('connections', vm.connectionName) },
                                                    {
                                                        title: (
                                                            <VmState vm={vm}
                                                                 vms={vms}
                                                                 dismissError={() => store.dispatch(updateVm({
                                                                     connectionName: vm.connectionName,
                                                                     name: vm.name,
                                                                     error: null
                                                                 }))} />
                                                        ),
                                                    },
                                                    { title: vmActions },
                                                ],
                                                props: {
                                                    key: cockpit.format("$0-$1-row", vmId(vm.name), vm.connectionName),
                                                    'data-row-id': cockpit.format("$0-$1", vmId(vm.name), vm.connectionName),
                                                    'data-vm-transient': !vm.persistent,
                                                },
                                            };
                                        }) }
                            />
                        </Card>
                    </Gallery>
                </PageSection>
            </Page>
        </WithDialogs>
    );
};
HostVmsList.propTypes = {
    vms: PropTypes.array.isRequired,
    config: PropTypes.object.isRequired,
    ui: PropTypes.object.isRequired,
    storagePools: PropTypes.array.isRequired,
    onAddErrorNotification: PropTypes.func.isRequired,
};

export default HostVmsList;
