import { $, el, fmtBytes, fmtDuration, fmtEta, fmtRate, coalesce } from './util.js';
import { formatCode } from '../shared/code.js';
import { isExecutable, trueExtension } from '../shared/text.js';
import { knownFingerprint } from './identity.js';
import { STATUS, isTerminal } from './transfer.js';
import { QrTooLong, encodeQr, qrToSvg } from './qr.js';

// Everything that touches the DOM.
//
// One rule throughout: text from another device is assigned with textContent,
// never interpolated into markup. Device names and filenames are chosen by
// whoever is on the other end of the connection.

const TRUST_BADGES = {
  verified: { text: 'verified', tone: 'ok', title: 'This device proved it holds the key we saw last time, and that the key is bound to this connection.' },
  mismatch: { text: 'key mismatch', tone: 'bad', title: 'This device presented a key that does not match this connection. Do not send anything sensitive — compare the check code below.' },
  unverified: { text: 'unverified', tone: '', title: 'No stable key on one side, so identity could not be checked.' },
};

export class UI {
  #transferRows = new Map();
  #handlers;

  /**
   * @param {object} handlers callbacks into the app; this module decides nothing
   */
  constructor(handlers) {
    this.#handlers = handlers;
    this.renderTransfers = coalesce((transfers) => this.#drawTransfers(transfers));
    this.renderMessages = coalesce((messages) => this.#drawMessages(messages));
  }

  // ── connection state ─────────────────────────────────────────────────────

  setConnection(state, detail) {
    const node = $('#conn');
    node.dataset.state = state;
    $('.conn-text', node).textContent = detail ?? {
      open: 'connected',
      connecting: 'connecting…',
      closed: 'offline — retrying',
      error: 'cannot reach the server',
    }[state] ?? state;
  }

  toast(message, tone = '') {
    const node = el('div', { class: `toast ${tone}`, text: message });
    $('#toasts').append(node);
    setTimeout(() => node.remove(), tone === 'bad' ? 7000 : 4000);
  }

  // ── the room ─────────────────────────────────────────────────────────────

  /**
   * @param {object|null} room
   * @param {{ canScan: boolean, others: number, problem?: string }} view
   *   `others` comes from the live roster, not from the room size the server sent
   *   with the last join — otherwise the count goes stale the moment somebody
   *   arrives, which is exactly when it is being read.
   */
  renderRoom(room, { canScan, others = 0, problem = '' }) {
    const actions = $('#room-actions');
    const share = $('#room-share');
    actions.replaceChildren();

    if (!room) {
      $('#room-what').textContent = problem || 'Connecting…';
      share.hidden = true;
      if (problem) {
        // A device with nowhere to go needs the way out in front of it, not in a
        // toast that has already gone.
        actions.append(
          el('button', { type: 'button', class: 'btn primary', text: 'Create a room code', onclick: () => this.#handlers.newRoom() }),
          el('button', { type: 'button', class: 'btn', text: 'Join a code', onclick: () => this.#handlers.openJoin() }),
        );
      }
      return;
    }

    if (room.kind === 'network') {
      $('#room-what').textContent = others
        ? `Grouped automatically by network address — ${others} other device${others === 1 ? '' : 's'} here.`
        : 'Grouped automatically by network address. Nothing else here yet.';
      share.hidden = true;

      actions.append(
        el('button', { type: 'button', class: 'btn primary', text: 'Create a room code', onclick: () => this.#handlers.newRoom() }),
        el('button', { type: 'button', class: 'btn', text: 'Join a code', onclick: () => this.#handlers.openJoin() }),
      );
      if (canScan) {
        actions.append(el('button', { type: 'button', class: 'btn', text: 'Scan QR', onclick: () => this.#handlers.openScan() }));
      }
      return;
    }

    // A code room. This is the path that always works — across networks, behind
    // carrier NAT, on a guest VLAN — so it gets the QR and the large type.
    $('#room-what').textContent = others
      ? `${others + 1} devices in this room, including you.`
      : 'Waiting for someone to join. Show them the code or the QR.';
    share.hidden = false;
    $('#room-code').textContent = formatCode(room.code);

    const link = this.roomUrl(room.code);
    $('#share-hint').textContent = `Open ${link} on the other device, or scan the code.`;
    this.#drawQr(link);

    actions.append(
      el('button', { type: 'button', class: 'btn', text: 'New code', onclick: () => this.#handlers.newRoom() }),
      el('button', { type: 'button', class: 'btn', text: 'Join another', onclick: () => this.#handlers.openJoin() }),
    );
  }

  roomUrl(code) { return `${location.origin}/#/r/${code}`; }

  #drawQr(text) {
    const figure = $('#qr');
    try {
      figure.replaceChildren(qrToSvg(encodeQr(text), { title: 'QR code for this room' }));
    } catch (err) {
      // Nothing about a missing QR should be fatal — the code is right beside it.
      figure.replaceChildren(el('p', {
        class: 'sub',
        text: err instanceof QrTooLong ? 'This address is too long for a QR code — type the code instead.' : 'QR unavailable.',
      }));
    }
  }

  // ── devices ──────────────────────────────────────────────────────────────

  renderPeers(peers, links) {
    const box = $('#peers');
    // A room-wide file action only adds something when there is more than one
    // target. With one peer, their named row is clearer and does the same job.
    const sendAll = $('#send-all');
    sendAll.hidden = peers.length < 2;
    sendAll.textContent = `Send files to all (${peers.length})`;

    // Message composition belongs with the message list, but it still depends
    // on there being someone here to receive it.
    $('#send-message').hidden = !peers.length;

    if (!peers.length) {
      // The hotspot line earns its place here rather than only in the failure
      // diagnosis. Waiting at an empty list is where someone on a different
      // network actually is, and by the time a connection has failed they have
      // usually given up. It is also the one arrangement that always works: two
      // devices on a phone's hotspot are on the same network by construction,
      // which is precisely what an install-first app builds for itself.
      box.replaceChildren(
        el('div', { class: 'empty' }, [
          el('p', { text: 'No other devices yet. Open this same page on another device on the same Wi-Fi, or share a room code.' }),
          el('p', {
            class: 'sub',
            text: 'On different networks, or the Wi-Fi blocks devices from seeing each other? '
              + "Turn on one phone's hotspot and put both devices on it.",
          }),
        ]),
      );
      return;
    }

    const rows = [];
    for (const peer of peers) {
      const link = links.get(peer.id);
      const row = el('button', { type: 'button', class: 'peer' });

      const meta = el('span', { class: 'meta' });
      // The same form this device shows for its own key, so the two can be
      // compared. A slice of the raw key would be unique but not comparable.
      const pubkey = link?.pubkey ?? peer.pubkey;
      const fingerprint = pubkey ? knownFingerprint(pubkey) : '';
      meta.append(el('span', { text: fingerprint ? `key ${fingerprint}` : peer.id }));

      if (link?.known) meta.append(badge('known', 'ok', 'You have transferred with this device before.'));
      if (link && link.trust !== 'unknown') {
        const info = TRUST_BADGES[link.trust];
        if (info && link.trust !== 'unverified') meta.append(badge(info.text, info.tone, info.title));
      }
      if (link?.pathLabel) meta.append(badge(link.pathLabel, link.pathTone, 'The route the bytes actually took.'));

      row.append(
        el('span', { class: 'who' }, [el('span', { class: 'nm', text: peer.name }), meta]),
        el('span', { class: 'go', text: 'Send files →' }),
      );

      row.addEventListener('click', () => this.#handlers.pickFilesFor(peer.id));
      this.#makeDropTarget(row, peer.id);
      rows.push(row);
    }

    box.replaceChildren(...rows);
  }

  /** Dropping files straight onto a device is the fastest path on a desktop, and
   *  dropping onto a named target removes the "which device?" step entirely. */
  #makeDropTarget(row, peerId) {
    const clear = () => row.classList.remove('drop');

    row.addEventListener('dragover', (event) => {
      event.preventDefault();
      row.classList.add('drop');
    });
    row.addEventListener('dragleave', clear);
    row.addEventListener('drop', (event) => {
      event.preventDefault();
      clear();
      const files = [...(event.dataTransfer?.files ?? [])];
      if (files.length) this.#handlers.sendFiles(peerId, files);
    });
  }

  // ── transfers ────────────────────────────────────────────────────────────

  #drawTransfers(transfers) {
    const box = $('#transfers');
    const list = [...transfers].sort((a, b) => b.key.localeCompare(a.key, undefined, { numeric: true }));

    if (!list.length) {
      this.#transferRows.clear();
      box.replaceChildren(el('div', { class: 'empty', text: 'Nothing sent or received yet.' }));
      $('#clear-done').hidden = true;
      return;
    }

    $('#clear-done').hidden = !list.some((transfer) => isTerminal(transfer.status));

    const nodes = [];
    for (const transfer of list) {
      let row = this.#transferRows.get(transfer.key);
      if (!row) {
        row = this.#buildTransferRow();
        this.#transferRows.set(transfer.key, row);
      }
      this.#updateTransferRow(row, transfer);
      nodes.push(row.root);
    }

    // Drop rows for transfers that no longer exist.
    for (const key of [...this.#transferRows.keys()]) {
      if (!list.some((transfer) => transfer.key === key)) this.#transferRows.delete(key);
    }

    box.replaceChildren(...nodes);
  }

  #buildTransferRow() {
    const dir = el('span', { class: 'tx-dir' });
    const title = el('span', { class: 'tx-title' });
    const meta = el('span', { class: 'tx-meta' });
    const fill = el('i');
    const note = el('p', { class: 'tx-note' });
    const files = el('ul', { class: 'tx-files' });
    const actions = el('div', { class: 'row-actions' });

    const root = el('article', { class: 'tx' }, [
      el('div', { class: 'tx-head' }, [dir, title, meta]),
      el('div', { class: 'bar-track' }, [fill]),
      note,
      files,
      actions,
    ]);

    // actionsKey and filesKey record what the children currently represent, so a
    // repaint that changes nothing leaves the nodes — and anything the user is
    // mid-click on — alone. fileStates maps a file id to the node showing its
    // byte count, which is updated in place.
    return { root, dir, title, meta, fill, note, files, actions, actionsKey: '', filesKey: '', fileStates: null };
  }

  #updateTransferRow(row, transfer) {
    const outgoing = transfer.direction === 'out';
    const total = transfer.totalBytes;
    const moved = transfer.movedBytes;

    row.root.dataset.status = transfer.status;
    row.dir.textContent = outgoing ? '↑' : '↓';

    const count = transfer.items.length;
    const headline = count === 1 ? transfer.items[0].name : `${count} files`;
    row.title.textContent = `${headline} ${outgoing ? 'to' : 'from'} ${transfer.peerName}`;

    const { bytes: rateBytes, ms: rateMs } = transfer.currentRate;
    const parts = [];
    if (transfer.status === STATUS.running || transfer.status === STATUS.paused) {
      parts.push(`${fmtBytes(moved)} / ${fmtBytes(total)}`, fmtRate(rateBytes, rateMs));
      const eta = fmtEta(rateBytes, total - transfer.rateFrom.bytes, rateMs);
      if (eta) parts.push(eta);
    } else if (transfer.status === STATUS.done) {
      parts.push(fmtBytes(total));
      if (rateMs > 0) parts.push(fmtRate(rateBytes, rateMs), `in ${fmtDuration(transfer.elapsedMs)}`);
    } else {
      parts.push(fmtBytes(total));
    }
    row.meta.textContent = parts.filter(Boolean).join(' · ');

    row.fill.parentElement.style.setProperty('--p', `${total ? Math.min(100, (moved / total) * 100) : 0}%`);

    this.#updateNote(row, transfer);
    this.#updateFileList(row, transfer);
    this.#updateActions(row, transfer);
  }

  #updateNote(row, transfer) {
    const bits = [];
    let tone = '';

    if (transfer.detail) bits.push(transfer.detail);

    if (transfer.path && transfer.status !== STATUS.failed) {
      bits.push(transfer.path.label + (transfer.path.rtt !== null ? ` · ${transfer.path.rtt} ms` : ''));
      tone = transfer.path.tone;
    }
    // Read live rather than cached: the session downgrades its own tier if the
    // fast path turns out to be unavailable, and the label has to follow.
    if (transfer.session?.label) bits.push(`via ${transfer.session.label}`);
    if (transfer.chunkSize) bits.push(`${fmtBytes(transfer.chunkSize)} chunks`);

    if (transfer.status === STATUS.done) {
      const verified = transfer.items.some((item) => item.crcOk === true);
      const unchecked = transfer.direction === 'in' && transfer.items.every((item) => item.crcOk === null);
      if (verified) { bits.push('checksum verified'); tone = 'ok'; }
      else if (unchecked) bits.push('not checksummed');
      else tone = 'ok';
    }
    if (transfer.status === STATUS.failed) tone = 'bad';
    if (transfer.status === STATUS.interrupted || transfer.status === STATUS.paused
      || transfer.status === STATUS.declined || transfer.status === STATUS.cancelled) tone = 'warn';

    row.note.className = `tx-note ${tone}`;
    row.note.textContent = bits.join(' · ');
    row.note.hidden = bits.length === 0;
  }

  #updateFileList(row, transfer) {
    const many = transfer.items.length > 1;
    const anySavable = transfer.items.some((item) => item.blob);

    if (!many && !anySavable) {
      if (row.filesKey !== 'none') {
        row.filesKey = 'none';
        row.fileStates = null;
        row.files.replaceChildren();
        row.files.hidden = true;
      }
      return;
    }

    // Structure is rebuilt only when it changes; the byte counts, which change
    // constantly, are written into the nodes already on the page. Same reason as
    // the action buttons — Save is a link someone has to be able to press, and
    // this row is redrawn whenever *any* transfer changes, so rebuilding it
    // unconditionally pulls that link out from under them for as long as
    // something else is still running.
    const key = transfer.items.map((item) => `${item.id}:${item.blob ? 1 : 0}`).join('|');
    if (row.filesKey !== key) {
      row.filesKey = key;
      row.fileStates = new Map();

      const nodes = transfer.items.map((item) => {
        const line = el('li');
        const name = el('span', { class: 'fn', text: item.name });
        line.append(name);

        // The extension the operating system will act on, not the one the name
        // suggests. This is the visible half of the spoofing mitigation.
        if (transfer.direction === 'in' && isExecutable(item.name)) {
          line.append(badge(`.${trueExtension(item.name)} runs code`, 'warn',
            'This file type executes when opened. Only continue if you know what it is.'));
        }

        if (item.blob) {
          // Created once and cached on the item. Minting a fresh object URL per
          // rebuild would leak one each time, and each one pins the whole file.
          item.objectUrl ??= URL.createObjectURL(item.blob);
          line.append(el('a', {
            class: 'save-link',
            href: item.objectUrl,
            download: item.name,
            text: 'Save',
            onclick: () => this.#handlers.savedFile(item),
          }));
        }

        const state = el('span', { class: 'fm' });
        row.fileStates.set(item.id, state);
        line.append(state);
        return line;
      });

      row.files.hidden = false;
      row.files.replaceChildren(...nodes);
    }

    for (const item of transfer.items) {
      const node = row.fileStates.get(item.id);
      if (node) node.textContent = fileStateText(item);
    }
  }

  /**
   * The buttons under a transfer.
   *
   * Rebuilt only when the set of them actually changes. This runs on every
   * repaint, and while bytes are moving a repaint lands every few frames — so
   * replacing the nodes unconditionally destroys the button under the pointer
   * between mousedown and mouseup. The click never completes, and Cancel appears
   * simply not to work. The handlers close over `transfer`, and a row is bound to
   * one transfer for its whole life, so keeping the nodes keeps them correct.
   */
  #updateActions(row, transfer) {
    const offering = transfer.direction === 'in' && transfer.status === STATUS.waiting;
    const key = offering
      ? `offer:${transfer.items.some((item) => isExecutable(item.name))}`
      : isTerminal(transfer.status) ? 'none' : 'cancel';
    if (row.actionsKey === key) return;
    row.actionsKey = key;

    const buttons = [];

    if (offering) {
      const executables = transfer.items.filter((item) => isExecutable(item.name));
      if (executables.length) {
        buttons.push(el('span', { class: 'sub' }, [
          badge('contains a program', 'warn', 'One or more of these files executes when opened.'),
        ]));
      }
      buttons.push(
        el('button', { type: 'button', class: 'btn primary', text: 'Accept', onclick: () => this.#handlers.accept(transfer) }),
        el('button', { type: 'button', class: 'btn', text: 'Decline', onclick: () => this.#handlers.decline(transfer) }),
      );
    } else if (!isTerminal(transfer.status)) {
      buttons.push(el('button', {
        type: 'button', class: 'btn danger', text: 'Cancel', onclick: () => this.#handlers.cancel(transfer),
      }));
    }

    row.actions.replaceChildren(...buttons);
    row.actions.hidden = buttons.length === 0;
  }

  // ── messages ───────────────────────────────────────────────────────────────

  /**
   * Notes and links, newest first.
   *
   * Rebuilt wholesale on every change, unlike the transfer rows: a message list
   * changes only when one arrives, is sent, or is cleared — never on a timer while
   * bytes move — so there is no repaint racing a click here, and the diffing the
   * transfer rows need would be machinery for a problem this list does not have.
   */
  #drawMessages(messages) {
    const box = $('#messages');
    $('#clear-messages').hidden = !messages.length;

    if (!messages.length) {
      box.replaceChildren(el('div', { class: 'empty', text: 'No messages yet. Send a link or a note to a device here.' }));
      return;
    }

    box.replaceChildren(...messages.map((message) => this.#buildMessageRow(message)));
  }

  #buildMessageRow(message) {
    const outgoing = message.direction === 'out';

    const head = el('div', { class: 'msg-head' }, [
      el('span', { class: 'msg-who', text: `${outgoing ? 'to' : 'from'} ${message.peerName}` }),
      el('span', { class: 'msg-time', text: fmtClock(message.at) }),
    ]);

    // textContent, like every other scrap of peer-chosen text on this page. The
    // body was already sanitised at the protocol boundary; this makes doubly sure
    // it is placed as text and never as markup.
    const body = el('p', { class: 'msg-body', text: message.body });

    const actions = el('div', { class: 'msg-actions' });
    actions.append(el('button', {
      type: 'button', class: 'icon-btn', 'aria-label': 'Copy', title: 'Copy',
      onclick: () => this.#handlers.copyMessage(message.body),
    }, [copyIcon()]));

    // Only http(s), and only ever on a click the user makes. A stranger's link is
    // never followed on its own.
    if (message.url) {
      actions.append(el('a', {
        class: 'btn', href: message.url, target: '_blank', rel: 'noopener noreferrer', text: 'Open',
      }));
    }

    return el('article', { class: 'msg', 'data-dir': message.direction }, [head, body, actions]);
  }

  // ── diagnostics ──────────────────────────────────────────────────────────

  renderCapabilities(rows) {
    const list = $('#caps');
    const nodes = [];
    for (const [label, value, tone = ''] of rows) {
      nodes.push(el('dt', { text: label }), el('dd', { class: tone, text: value }));
    }
    list.replaceChildren(...nodes);
  }

  renderLinks(summaries) {
    const box = $('#links');
    if (!summaries.length) {
      box.className = 'sub';
      box.replaceChildren(document.createTextNode('No connections yet.'));
      return;
    }
    box.className = '';

    const cards = summaries.map((summary) => {
      const card = el('div', { class: 'link-card' });
      card.append(el('strong', { text: summary.name }));
      card.append(el('div', { class: 'kv', text:
        `${summary.state} · ICE ${summary.iceState} · ${summary.path.label}`
        + (summary.path.localType ? ` (${summary.path.localType} ↔ ${summary.path.remoteType})` : '')
        + (summary.maxMessageSize ? ` · SCTP max ${fmtBytes(summary.maxMessageSize)}` : '')
        + ` · ${summary.polite ? 'polite' : 'impolite'}` }));

      const trust = TRUST_BADGES[summary.trust];
      if (trust) {
        const line = el('div');
        line.append(badge(trust.text, trust.tone, trust.title));
        // On first contact there is no remembered key to check against, so the
        // fallback is two humans comparing a number. A server substituting
        // fingerprints cannot make both devices show the same one.
        if (summary.sas && summary.trust !== 'verified') {
          line.append(el('span', { class: 'kv', text: ` check code ${summary.sas} — it should match on both devices` }));
        }
        card.append(line);
      }

      if (summary.log.length) {
        card.append(el('pre', {
          class: 'ice-log',
          text: summary.log.map((entry) => `${entry.kind}: ${entry.detail}`).join('\n'),
        }));
      }
      return card;
    });

    box.replaceChildren(...cards);
  }
}

function badge(text, tone = '', title = '') {
  return el('span', { class: `badge ${tone}`, text, title: title || false });
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The two-sheet copy glyph, built through the SVG namespace rather than an
 *  innerHTML string, to keep to the one-rule-throughout of never assigning
 *  markup. */
function copyIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const d of [
    'M16 1H4a2 2 0 0 0-2 2v12h2V3h12V1z',
    'M20 5H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h12v14z',
  ]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/** A wall-clock time for a message, in the viewer's locale. */
function fmtClock(at) {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** The right-hand figure on one file's line. */
function fileStateText(item) {
  if (item.status === STATUS.done) return fmtBytes(item.size);
  if (item.status === STATUS.failed) return item.skipReason || 'failed';
  if (item.status === STATUS.declined) return 'skipped';
  return `${fmtBytes(item.progress)} / ${fmtBytes(item.size)}`;
}
