/*
 * This file is part of Cockpit.
 *
 * Copyright (C) 2021 Red Hat, Inc.
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

import cockpit from 'cockpit';

import { optString } from './types';

import { getDoc, getSingleOptionalElem } from './libvirt-xml-parse.js';
import { getNextAvailableTarget, logDebug, BootOrderDevice } from './helpers.js';

export function changeMedia({
    domXml,
    target,
    eject,
    file,
    pool,
    volume
} : {
    domXml: string,
    target: string,
    eject: boolean,
    file: string | undefined,
    pool: string | undefined,
    volume: string | undefined,
}): string {
    const s = new XMLSerializer();
    const doc = getDoc(domXml);
    const domainElem = doc.firstElementChild;
    if (!domainElem)
        throw new Error("changeMedia: domXML has no domain element");

    const deviceElem = domainElem.getElementsByTagName("devices")[0];
    const disks = deviceElem.getElementsByTagName("disk");

    let deviceXml: Node | undefined;
    for (let i = 0; i < disks.length; i++) {
        const disk = disks[i];
        const diskTarget = disk.getElementsByTagName("target")[0].getAttribute("dev");
        if (diskTarget == target) {
            let sourceElem = getSingleOptionalElem(disk, "source");

            if (eject) {
                if (sourceElem)
                    sourceElem.remove();
            } else {
                if (!sourceElem) {
                    sourceElem = doc.createElement("source");
                    disk.appendChild(sourceElem);
                }

                if (file) {
                    sourceElem.setAttribute("file", file);
                } else if (pool && volume) {
                    sourceElem.setAttribute("pool", pool);
                    sourceElem.setAttribute("volume", volume);
                }
            }

            deviceXml = disk;
        }
    }

    return deviceXml ? s.serializeToString(deviceXml) : domXml;
}

export function updateDisk({
    domXml,
    diskTarget,
    readonly,
    shareable,
    busType,
    existingTargets,
    cache
} : {
    domXml: string,
    diskTarget: optString,
    readonly: boolean,
    shareable: boolean,
    busType: optString,
    existingTargets: string[],
    cache: optString,
}): string {
    const s = new XMLSerializer();
    const doc = getDoc(domXml);
    const domainElem = doc.firstElementChild;
    if (!domainElem)
        throw new Error("updateDisk: domXML has no domain element");

    const deviceElem = domainElem.getElementsByTagName("devices")[0];
    const disks = deviceElem.getElementsByTagName("disk");

    for (let i = 0; i < disks.length; i++) {
        const disk = disks[i];
        const target = disk.getElementsByTagName("target")[0].getAttribute("dev");
        if (target == diskTarget) {
            let shareAbleElem = getSingleOptionalElem(disk, "shareable");
            if (!shareAbleElem && shareable) {
                shareAbleElem = doc.createElement("shareable");
                disk.appendChild(shareAbleElem);
            } else if (shareAbleElem && !shareable) {
                shareAbleElem.remove();
            }

            let readOnlyElem = getSingleOptionalElem(disk, "readonly");
            if (!readOnlyElem && readonly) {
                readOnlyElem = doc.createElement("readonly");
                disk.appendChild(readOnlyElem);
            } else if (readOnlyElem && !readonly) {
                readOnlyElem.remove();
            }

            const targetElem = disk.getElementsByTagName("target")[0];
            const oldBusType = targetElem.getAttribute("bus");
            if (busType && oldBusType !== busType) {
                targetElem.setAttribute("bus", busType);
                const newTarget = getNextAvailableTarget(existingTargets, busType);
                if (!newTarget)
                    throw new Error("updateBootOrder: no free target");
                targetElem.setAttribute("dev", newTarget);

                const addressElem = getSingleOptionalElem(disk, "address");
                if (addressElem)
                    addressElem.remove();
            }

            const driverElem = disk.getElementsByTagName("driver")[0];
            if (cache)
                driverElem.setAttribute("cache", cache);
        }
    }

    return s.serializeToString(doc);
}

export function updateBootOrder(domXml: string, devices: BootOrderDevice[]): string {
    const s = new XMLSerializer();
    const doc = getDoc(domXml);
    const domainElem = doc.firstElementChild;
    if (!domainElem)
        throw new Error("updateBootOrder: domXML has no domain element");

    const deviceElem = domainElem.getElementsByTagName("devices")[0];
    const disks = deviceElem.getElementsByTagName("disk");
    const interfaces = deviceElem.getElementsByTagName("interface");
    const hostdevs = deviceElem.getElementsByTagName("hostdev");
    const redirdevs = deviceElem.getElementsByTagName("redirdev");

    if (devices) {
        // only boot option in devices shall be used, boot options in OS therefore has to be removed
        const osBootElems = domainElem.getElementsByTagName("os")[0].getElementsByTagName("boot");
        while (osBootElems.length)
            osBootElems[0].remove();
    }

    // Update Disks
    for (let i = 0; i < disks.length; i++) {
        const disk = disks[i];
        const target = disk.getElementsByTagName("target")[0].getAttribute("dev");
        const index = devices.findIndex(t => t.type == "disk" && t.device.target === target);

        let bootElem = getSingleOptionalElem(disk, "boot");
        if (index >= 0) { // it will have bootorder
            if (!bootElem) {
                bootElem = doc.createElement("boot");
                disk.appendChild(bootElem);
            }
            bootElem.setAttribute("order", String(index + 1));
        } else {
            if (bootElem) // it's has boot order, but it's ought to not have one, so we delete it
                bootElem.remove();
        }
    }

    // Update interfaces
    for (let i = 0; i < interfaces.length; i++) {
        const iface = interfaces[i];
        const mac = iface.getElementsByTagName("mac")[0].getAttribute("address");
        const index = devices.findIndex(t => t.type == "network" && t.device.mac === mac);

        let bootElem = getSingleOptionalElem(iface, "boot");
        if (index >= 0) { // it will have bootorder
            if (!bootElem) {
                bootElem = doc.createElement("boot");
                iface.appendChild(bootElem);
            }
            bootElem.setAttribute("order", String(index + 1));
        } else {
            if (bootElem) // it's has boot order, but it's ought to not have one, so we delete it
                bootElem.remove();
        }
    }

    // Update redirected devices
    for (let i = 0; i < redirdevs.length; i++) {
        const redirdev = redirdevs[i];
        const port = redirdev.getElementsByTagName("address")[0].getAttribute("port");
        const index = devices.findIndex(t => t.type == "redirdev" && t.device.address?.port === port);

        let bootElem = getSingleOptionalElem(redirdev, "boot");
        if (index >= 0) { // it will have bootorder
            if (!bootElem) {
                bootElem = doc.createElement("boot");
                redirdev.appendChild(bootElem);
            }
            bootElem.setAttribute("order", String(index + 1));
        } else {
            if (bootElem) // it's has boot order, but it's ought to not have one, so we delete it
                bootElem.remove();
        }
    }

    // Update host devices
    for (let i = 0; i < hostdevs.length; i++) {
        const hostdev = hostdevs[i];
        const type = hostdev.getAttribute("type");
        const sourceElem = hostdev.getElementsByTagName("source")[0];
        let bootElem = getSingleOptionalElem(hostdev, "boot");
        let index;

        if (type === "usb") {
            const vendorElem = getSingleOptionalElem(sourceElem, "vendor");
            const productElem = getSingleOptionalElem(sourceElem, "product");
            const addressElem = getSingleOptionalElem(hostdev, "address");

            if (vendorElem && productElem) {
                const vendorId = vendorElem.getAttribute('id');
                const productId = productElem.getAttribute('id');

                index = devices.findIndex(t => {
                    if (t.type == "hostdev" && t.device.type == "usb" && t.device.source.vendor && t.device.source.product)
                        return t.device.source.vendor.id === vendorId && t.device.source.product.id === productId;
                    else
                        return false;
                });
            } else if (addressElem) {
                const port = addressElem.getAttribute('port');

                index = devices.findIndex(t => {
                    if (t.type == "hostdev" && t.device.type == "usb" && t.device.address)
                        return t.device.address.port === port;
                    else
                        return false;
                });
            }
        } else if (type === "pci") {
            const addressElem = hostdev.getElementsByTagName("address")[0];

            const domain = addressElem.getAttribute('domain');
            const bus = addressElem.getAttribute('bus');
            const slot = addressElem.getAttribute('slot');
            const func = addressElem.getAttribute('function');

            index = devices.findIndex(t => {
                if (t.type == "hostdev" && t.device.type == "pci" && t.device.source.address)
                    return t.device.source.address.domain === domain &&
                           t.device.source.address.bus === bus &&
                           t.device.source.address.slot === slot &&
                           t.device.source.address.func === func;
                else
                    return false;
            });
        } else if (type === "scsi") {
            const addressElem = getSingleOptionalElem(sourceElem, "address");
            const adapterElem = getSingleOptionalElem(sourceElem, "adapter");

            const protocol = addressElem?.getAttribute('protocol');
            const name = addressElem?.getAttribute('name');

            if (addressElem && adapterElem) {
                const bus = addressElem.getAttribute('bus');
                const target = addressElem.getAttribute('target');
                const unit = addressElem.getAttribute('unit');
                const adapterName = adapterElem.getAttribute('name');

                index = devices.findIndex(t => {
                    if (t.type == "hostdev" && t.device.type == "scsi" && t.device.source.address && t.device.source.adapter)
                        return t.device.source.address.bus === bus &&
                               t.device.source.address.target === target &&
                               t.device.source.address.unit === unit &&
                               t.device.source.adapter.name === adapterName;
                    else
                        return false;
                });
            } else if (protocol && name) {
                index = devices.findIndex(t => {
                    if (t.type == "hostdev" && t.device.type == "scsi" && t.device.source.address)
                        return t.device.source.protocol === protocol &&
                               t.device.source.name === name;
                    else
                        return false;
                });
            }
        } else if (type === "scsi_host") {
            const wwpn = sourceElem.getAttribute('wwpn');
            const protocol = sourceElem.getAttribute('protocol');

            index = devices.findIndex(t => t.type == "hostdev" && t.device.type == "scsi_host" &&
                                           t.device.source.wwpn === wwpn &&
                                           t.device.source.protocol === protocol);
        } else if (type === "mdev") {
            const addressElem = hostdev.getElementsByTagName("address")[0];
            const uuid = addressElem.getAttribute('uuid');

            index = devices.findIndex(t => {
                if (t.type == "hostdev" && t.device.type == "mdev" && t.device.source.address)
                    return t.device.source.address.uuid === uuid;
                else
                    return false;
            });
        }

        if (index && index >= 0) { // it will have bootorder
            if (!bootElem) {
                bootElem = doc.createElement("boot");
                hostdev.appendChild(bootElem);
            }
            bootElem.setAttribute("order", String(index + 1));
        } else {
            if (bootElem) // it's has boot order, but it's ought to not have one, so we delete it
                bootElem.remove();
        }
    }

    return s.serializeToString(doc);
}

/*
 * This function is used to define only offline attribute of memory.
 */
export function updateMaxMemory(domXml: string, maxMemory: number): string {
    const doc = getDoc(domXml);
    const domainElem = doc.firstElementChild;
    const s = new XMLSerializer();

    const memElem = domainElem?.getElementsByTagName("memory")[0];
    cockpit.assert(memElem, "No memory element");
    memElem.textContent = `${maxMemory}`;

    return s.serializeToString(doc);
}

function xmlGetXPath(doc: XMLDocument, xpath: string): Element[] {
    const elements: Element[] = [];
    let node = null;
    const iterator = doc.evaluate(xpath, doc);
    while ((node = iterator.iterateNext()))
        if (node instanceof Element)
            elements.push(node);
    return elements;
}

export function replaceSpice(domXml: string): string {
    // this implements https://access.redhat.com/solutions/6955095
    logDebug("replaceSpice original XML:", domXml);

    const doc = getDoc(domXml);

    xmlGetXPath(doc, "/domain/devices/audio[@type='spice']").forEach(n => n.remove());
    xmlGetXPath(doc, "//domain/devices/redirdev[@type='spicevmc']").forEach(n => n.remove());
    xmlGetXPath(doc, "//domain/devices/channel[@type='spicevmc']").forEach(n => n.remove());

    xmlGetXPath(doc, "//domain/devices/video").forEach(video => {
        const model = getSingleOptionalElem(video, "model");
        if (model?.getAttribute("type") === "qxl") {
            // remove all attributes except for primary; don't change list while iterating
            const removeAttrs = [];
            for (let i = 0; i < model.attributes.length; i++) {
                const attr = model.attributes.item(i);
                if (attr && attr.name !== "primary")
                    removeAttrs.push(attr.name);
            }
            removeAttrs.forEach(attr => model.removeAttribute(attr));
            model.setAttribute("type", "vga");
        }
    });

    const spice_graphics = xmlGetXPath(doc, "//domain/devices/graphics[@type='spice']");
    // do we already have a VNC graphics device?
    if (xmlGetXPath(doc, "//domain/devices/graphics[@type='vnc']").length > 0) {
        // then simply remove the spice graphics device
        spice_graphics.forEach(graphics => graphics.remove());
    } else {
        // otherwise replace spice graphics with VNC
        spice_graphics.forEach(graphics => {
            graphics.setAttribute("type", "vnc");
            graphics.setAttribute("port", "-1");
            getSingleOptionalElem(graphics, "image")?.remove();
        });
    }

    const result = (new XMLSerializer()).serializeToString(doc);
    logDebug("replaceSpice updated XML:", result);
    return result;
}
