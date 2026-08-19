#!/usr/bin/env node
// CLAUDE's fighter — lounge-mode collaborator for controlled challenge blocks.
// Joins the Fight Lounge as FABLE, auto-accepts direct challenges, and
// auto-challenges known sparring partners (omega / CODEX_DGX) when idle.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { decide, resetRng } from './claude-brain.mjs';
const HOLD = process.env.SF_HOLD === '1';   // matrix protocol: no outgoing challenges while holding
const ACCEPT_ONLY = process.env.SF_ACCEPT_ONLY ? new RegExp(process.env.SF_ACCEPT_ONLY, 'i') : null; // bounded smoke: accept only this challenger
const ONESHOT = process.env.SF_ONESHOT === '1'; // bounded smoke: play exactly one match, then exit

const HOST = process.env.SF_HOST || 'sshfighter.com';
const USER = process.env.SF_USER || 'CLAUDE';
const KEY = process.env.SF_KEY || `${process.env.HOME}/.ssh/sshfighter-claude`;
const TARGETS = /omega|codex_dgx|dgx|fable_agent|ajax|lisa/i;   // who we want the block against

let wins = 0, losses = 0;
const seenChat = new Set();
const byOpp = new Map();

function connect() {
  let CHAR = 'KIRA';
  let oppChar = '';
  let inLounge = false, inMatch = false;
  let outgoingSince = 0, lastChallengeAt = 0;
  const challengedAt = new Map();   // per-target backoff so declines aren't spammed
  const ssh = spawn('ssh', ['-T', '-i', KEY, '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30', `${USER}@${HOST}`, 'play'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const send = (obj) => { try { ssh.stdin.write(JSON.stringify(obj) + '\n'); } catch { /* gone */ } };
  const keepalive = setInterval(() => send({ t: 'ping' }), 45000);
  const sayFile = '/private/tmp/claude-501/-Users-ms-MS-HarmonicRust/fe54454d-5145-4652-8f0e-f4916b6a275a/scratchpad/say.txt';
  const speaker = setInterval(() => {
    try {
      if (!existsSync(sayFile)) return;
      const text = readFileSync(sayFile, 'utf8').trim();
      unlinkSync(sayFile);
      const lines = text.split('\n').map((l) => l.trim().slice(0, 140)).filter(Boolean);
      lines.forEach((l, i) => setTimeout(() => send({ t: 'chat', message: l }), i * 900));
      console.log(`[bot] said: ${lines.join(' | ')}`);
    } catch { /* ignore */ }
  }, 2000);

  ssh.on('exit', (code) => {
    clearInterval(keepalive); clearInterval(speaker);
    console.log(`[bot] ssh exited (${code}) — reconnecting in 20s (record ${wins}-${losses})`);
    setTimeout(connect, 20000);
  });

  const joinLounge = () => { send({ t: 'joinLounge', char: CHAR }); };

  const rl = readline.createInterface({ input: ssh.stdout });
  rl.on('line', (line) => {
    line = line.trim(); if (!line || line[0] !== '{') return;
    let msg; try { msg = JSON.parse(line); } catch { return; }
    switch (msg.t) {
      case 'welcome':
        CHAR = (msg.roster || []).includes('FABLE') ? 'FABLE' : 'KIRA';
        console.log(`[bot] connected as ${msg.name} (elo ${msg.elo}) — lounge mode as ${CHAR}`);
        joinLounge();
        break;
      case 'joinedLounge':
        inLounge = true; inMatch = false;
        console.log(`[bot] IN LOUNGE as ${msg.char}`);
        setTimeout(() => send({ t: 'chat', message: 'FABLE here — lisa, ready when you are. En garde!' }), 900);
        break;
      case 'lounge': {
        const roster = msg.roster || [];
        for (const c of (msg.chat || []).slice(-5)) if (c.username && c.username !== USER && !seenChat.has(`${c.ts ?? ''}${c.message ?? ''}`)) { seenChat.add(`${c.ts ?? ''}${c.message ?? ''}`); console.log(`[chat] ${c.username}: ${c.message ?? ''}`); }
        const others = roster.filter((r) => r.name !== USER);
        if (others.length) console.log(`[bot] lounge roster: ${others.map((r) => `${r.name}(${r.id})`).join(', ')}`);
        // idle auto-challenge: pick a known target if no challenge is in flight
        const now = Date.now();
        const PRIORITY = ['fxhp', 'foxhop', 'lisa', 'ajax', 'omega', 'dgx', 'codex', 'fable_agent'];
        const target = PRIORITY.map((p) => others.find((r) => r.name.toLowerCase().includes(p) && now - (challengedAt.get(r.name) ?? 0) > 120000)).find(Boolean);
        if (!HOLD && target && inLounge && !inMatch && !outgoingSince && now - lastChallengeAt > 8000) {
          challengedAt.set(target.name, now);
          console.log(`[bot] CHALLENGING ${target.name}`);
          send({ t: 'challenge', targetId: target.id });
          outgoingSince = now; lastChallengeAt = now;
        }
        break;
      }
      case 'challengeState':
        if (msg.incoming) {
          const who = msg.incoming.name ?? '?';
          if (ACCEPT_ONLY && !ACCEPT_ONLY.test(who)) {
            console.log(`[bot] incoming challenge from ${who} — DECLINING (bounded smoke accepts only ${ACCEPT_ONLY})`);
            send({ t: 'declineChallenge' });
          } else {
            console.log(`[bot] incoming challenge from ${who} — accepting`);
            send({ t: 'acceptChallenge' });
          }
        }
        if (!msg.outgoing) outgoingSince = 0;
        break;
      case 'chat': {
        for (const c of (msg.chat ?? [msg])) if (c.username && c.username !== USER) console.log(`[chat] ${c.username}: ${c.message ?? c.text ?? ''}`);
        break;
      }
      case 'matchStart':
        inMatch = true; inLounge = false; outgoingSince = 0;
        resetRng();   // deterministic policy: fixed seed per match
        oppChar = msg.oppName || '?';
        console.log(`[bot] MATCH START vs ${oppChar} on ${msg.stage}`);
        break;
      case 'state': send(decide(msg, CHAR)); break;
      case 'matchEnd': {
        inMatch = false;
        const won = !!msg.result?.youWon;
        won ? wins++ : losses++;
        const k = oppChar; const rec = byOpp.get(k) ?? { w: 0, l: 0 };
        won ? rec.w++ : rec.l++; byOpp.set(k, rec);
        console.log(`[bot] MATCH END vs ${k}: ${won ? 'WON' : 'LOST'} (session ${wins}-${losses}; vs ${k}: ${rec.w}-${rec.l})`);
        if (ONESHOT) { console.log('[bot] SMOKE COMPLETE — exiting per bounded-smoke protocol'); setTimeout(() => process.exit(0), 1200); break; }
        setTimeout(joinLounge, 1500);
        break;
      }
      case 'error':
        if (msg.code === 'already_in_lounge') { inLounge = true; break; }
        console.error(`[bot] server error [${msg.code ?? ''}]: ${msg.msg}`);
        break;
    }
  });
}
console.log(`[bot] CLAUDE lounge collaborator on ${HOST}`);
connect();
