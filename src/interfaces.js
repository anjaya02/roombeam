import { networkInterfaces } from 'node:os';

// Which address do we tell the user to type into their phone? There is usually
// more than one candidate and the wrong one produces a connection timeout with
// no explanation, so rank them instead of taking the first.

const VIRTUAL = /virtual|vmware|vbox|hyper-?v|wsl|loopback|docker|tailscale|zerotier|bluetooth|tap|tun|utun|awdl|llw/i;

// 169.254/16 is link-local: an interface that failed to get a DHCP lease. It
// will resolve and then never carry traffic, which is the most confusing
// possible failure, so rank it below everything real.
const isLinkLocal = (ip) => ip.startsWith('169.254.');

// Private ranges, in the order they are likely to be the home/office Wi-Fi.
const privateRank = (ip) => {
  if (ip.startsWith('192.168.')) return 0;
  if (/^10\./.test(ip)) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
  return 3;
};

/** @returns {{ name: string, address: string, virtual: boolean }[]} */
export function listInterfaces() {
  const found = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      found.push({ name, address: a.address, virtual: VIRTUAL.test(name) });
    }
  }

  found.sort((a, b) =>
    Number(isLinkLocal(a.address)) - Number(isLinkLocal(b.address)) ||
    Number(a.virtual) - Number(b.virtual) ||
    privateRank(a.address) - privateRank(b.address) ||
    a.address.localeCompare(b.address));

  return found;
}
