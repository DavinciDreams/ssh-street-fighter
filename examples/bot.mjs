#!/usr/bin/env node
// ============================================================================
// SSH Street Fighter — example bot
// ----------------------------------------------------------------------------
// A bot is just an ordinary player that reaches the game over an API instead of
// a terminal. Identity is anchored to your SSH key, so give each bot its own key
// if its handle, rating, and match history should be independent. Bots queue for
// quick matches against humans and bots alike.
//
//   1. Create a dedicated key and claim its handle in one interactive login:
//        ssh-keygen -t ed25519 -f ~/.ssh/sshfighter-mybot -C sshfighter-mybot
//        ssh -i ~/.ssh/sshfighter-mybot -o IdentitiesOnly=yes MYBOT@sshfighter.com
//
//   2. Play — the recommended path streams the match over SSH itself:
//        node examples/bot.mjs --user MYBOT --host sshfighter.com --char BYU \
//          --identity ~/.ssh/sshfighter-mybot
//
//      That spawns `ssh -i <key> -o IdentitiesOnly=yes MYBOT@sshfighter.com play`
//      and speaks newline-delimited JSON over the channel. No API key is needed
//      on this path.
//
//   3. Optional: mint an API key for REST or direct TCP access:
//        ssh -i ~/.ssh/sshfighter-mybot -o IdentitiesOnly=yes MYBOT@sshfighter.com token
//
//      Direct TCP (if the bot port is reachable) authenticates with that token:
//        node examples/bot.mjs --tcp <host>:8091 --key rk_xxx --char BYU
//
// Protocol (newline-delimited JSON both ways):
//   you  -> {"t":"queue","char":"BYU"}
//   you  -> {"t":"input","moveX":-1|0|1,"jump":bool,"punch":bool,"kick":bool,"down":bool,"motion":"DR"}
//   game -> {"t":"welcome",...} {"t":"matchStart",...} {"t":"state",...} {"t":"matchEnd",...}
//
// The `state` gives you the world from your perspective: `you`, `opp`, and
// `projectiles`, plus phase/round. `motion` is an absolute-direction string the
// engine matches with endsWith(), so (facing right) "DR"+punch = fireball,
// "RDR"+punch = dragon punch, "DL"+kick = hurricane kick.
// ============================================================================
import { spawn } from 'node:child_process';
import net from 'node:net';
import readline from 'node:readline';

// ---- args ----
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (!arg.startsWith('--')) continue;
  const name = arg.slice(2);
  const next = process.argv[i + 1];
  args[name] = next && !next.startsWith('--') ? process.argv[++i] : true;
}

if (args.help) {
  console.log(`Usage:
  node examples/bot.mjs [--user NAME] [--host HOST] [--char FIGHTER] [--identity KEY] [--max-matches N]
  node examples/bot.mjs --tcp HOST:PORT --key rk_xxx [--char FIGHTER]

Options:
  --identity KEY  Dedicated SSH private key. Also enables IdentitiesOnly=yes.
  --user NAME     SSH username (default: BOT).
  --host HOST     SSH host (default: sshfighter.com).
  --char FIGHTER  Fighter to queue as (default: BYU).
  --max-matches N Stop after N completed matches.
  --tcp HOST:PORT Use direct TCP instead of the recommended SSH transport.
  --key TOKEN     API key required by direct TCP.
  --help          Show this help.`);
  process.exit(0);
}

for (const name of ['identity', 'user', 'host', 'char', 'tcp', 'key', 'max-matches', 'policy']) {
  if (args[name] === true) {
    console.error(`--${name} requires a value`);
    process.exit(2);
  }
}

const CHAR = args.char || 'BYU';
const HOST = args.host || 'sshfighter.com';
const USER = args.user || 'BOT';
const MAX_MATCHES = args['max-matches'] ? Math.max(1, parseInt(String(args['max-matches']), 10) || 1) : Infinity;
const POLICY_VERSION = args.policy || 'example-fable-v1';

// ---- transport: SSH `play` (default) or direct TCP with an API key ----
let toGame;          // write a JSON object to the game
let lineSource;      // an async iterable / stream of JSON lines from the game
let preAuthed = true;

if (args.tcp) {
  const [h, p] = String(args.tcp).split(':');
  const sock = net.connect(parseInt(p || '8091', 10), h);
  sock.setNoDelay(true);
  toGame = (obj) => sock.write(JSON.stringify(obj) + '\n');
  lineSource = readline.createInterface({ input: sock });
  preAuthed = false;   // must send {t:'hello',key}
  if (!args.key) { console.error('--tcp requires --key rk_... (mint via: ssh host token)'); process.exit(1); }
} else {
  // Spawn ssh and run the `play` command. A dedicated identity keeps this bot's
  // handle, rating, and match history separate from the operator's account.
  const sshArgs = ['-T'];
  if (args.identity) sshArgs.push('-i', String(args.identity), '-o', 'IdentitiesOnly=yes');
  sshArgs.push(`${USER}@${HOST}`, 'play');
  const ssh = spawn('ssh', sshArgs, { stdio: ['pipe', 'pipe', 'inherit'] });
  ssh.on('exit', (code) => { console.log(`ssh exited (${code})`); process.exit(code || 0); });
  toGame = (obj) => ssh.stdin.write(JSON.stringify(obj) + '\n');
  lineSource = readline.createInterface({ input: ssh.stdout });
}

// ---- a small quick-match brain ----
const R = () => Math.random();
function decide(st) {
  const { you, opp, phase } = st;
  const cmd = { t: 'input', moveX: 0, motion: 'N' };   // 'N' = neutral (won't trigger a special)
  if (phase !== 'fight' || !you || !opp) return cmd;    // idle during countdown / round breaks

  const dx = opp.x - you.x;
  const dist = Math.abs(dx);
  const towards = Math.sign(dx) || you.facing;          // walk toward the opponent
  const f = you.facing;                                 // 1 = facing right, -1 = left
  const oppAir = opp.y > 8;
  const oppAttacking = opp.attack && opp.attack !== 'none';

  if (CHAR.toUpperCase() === 'FABLE') {
    const back = f === 1 ? 'L' : 'R';
    const forward = f === 1 ? 'R' : 'L';
    if (oppAir && dist < 70) {                           // Story Arc checks jump-ins
      cmd.motion = 'DU'; cmd.punch = true;
    } else if (oppAttacking && dist < 62) {
      cmd.moveX = -towards;                              // respect active frames
      if (R() < 0.12) { cmd.motion = `${back}${forward}`; cmd.kick = true; }
    } else if (dist < 38) {
      if (R() < 0.45) cmd.punch = true; else if (R() < 0.85) cmd.kick = true;
      else { cmd.motion = `${back}${forward}`; cmd.kick = true; }
    } else if (dist < 105) {
      cmd.moveX = towards;
      if (R() < 0.08) { cmd.motion = `${back}${forward}`; cmd.kick = true; }  // Plot Twist
      else if (R() < 0.05) { cmd.motion = `D${back}`; cmd.punch = true; }     // Ink Tempest
    } else {
      if (R() < 0.26) { cmd.motion = `D${back}`; cmd.punch = true; }          // Ink Tempest zoning
      else cmd.moveX = towards;
      if (R() < 0.025) cmd.jump = true;
    }
    return cmd;
  }

  if (oppAir && dist < 58) {                            // anti-air: dragon punch a jump-in
    cmd.motion = f === 1 ? 'RDR' : 'LDL'; cmd.punch = true;
  } else if (dist < 42) {                               // point blank: block or strike
    if (oppAttacking && R() < 0.7) cmd.moveX = -towards;      // hold away to block
    else if (R() < 0.5) cmd.punch = true; else cmd.kick = true;
  } else if (dist < 115) {                              // mid: approach, sometimes hurricane in
    cmd.moveX = towards;
    if (R() < 0.04) { cmd.motion = f === 1 ? 'DL' : 'DR'; cmd.kick = true; }
  } else {                                              // far: fireball zoning + advance
    if (R() < 0.28) { cmd.motion = f === 1 ? 'DR' : 'DL'; cmd.punch = true; }
    else cmd.moveX = towards;
    if (R() < 0.03) cmd.jump = true;
  }
  return cmd;
}

// ---- drive the connection ----
let wins = 0, losses = 0;
let roster = [];
let ownName = USER;
let current = null;
function freshCounts() {
  return {
    states: 0, inputs: 0, walkToward: 0, block: 0, punch: 0, kick: 0, jump: 0,
    neutral: 0, specials: {}, motions: {},
  };
}
function countDecision(st, cmd) {
  if (!current) return;
  current.counts.states++;
  current.counts.inputs++;
  if (cmd.moveX) current.counts.walkToward++;
  if (cmd.jump) current.counts.jump++;
  if (cmd.punch) current.counts.punch++;
  if (cmd.kick) current.counts.kick++;
  if (!cmd.moveX && !cmd.jump && !cmd.punch && !cmd.kick) current.counts.neutral++;
  if (st?.opp?.attack && st.opp.attack !== 'none' && cmd.moveX) current.counts.block++;
  if (cmd.motion && cmd.motion !== 'N') {
    current.counts.motions[cmd.motion] = (current.counts.motions[cmd.motion] || 0) + 1;
    const special = `${cmd.motion}${cmd.punch ? '+P' : cmd.kick ? '+K' : ''}`;
    current.counts.specials[special] = (current.counts.specials[special] || 0) + 1;
  }
}
lineSource.on('line', (line) => {
  line = line.trim(); if (!line || line[0] !== '{') return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  switch (msg.t) {
    case 'hi':                                          // TCP mode: authenticate, then queue
      if (!preAuthed) toGame({ t: 'hello', key: args.key });
      break;
    case 'welcome':
      roster = Array.isArray(msg.roster) ? msg.roster : [];
      ownName = msg.name || USER;
      console.log(`connected as ${msg.name} (elo ${msg.elo}) — queueing as ${CHAR}`);
      toGame({ t: 'queue', char: CHAR });
      break;
    case 'queued': console.log(`in queue as ${msg.char}…`); break;
    case 'matchStart':
      current = {
        matchId: msg.mid,
        handle: ownName,
        character: CHAR,
        opponentHandle: msg.oppName,
        opponentCharacter: roster[msg.oppCursor] || String(msg.oppCursor ?? 'unknown'),
        policyVersion: POLICY_VERSION,
        map: msg.stage,
        role: msg.role,
        counts: freshCounts(),
        lastState: null,
      };
      console.log(`match! ${msg.mid} you are ${msg.role} on ${msg.stage} vs ${msg.oppName}/${current.opponentCharacter}`);
      break;
    case 'state': {
      if (current) current.lastState = msg;
      const cmd = decide(msg);
      countDecision(msg, cmd);
      toGame(cmd);
      break;
    }
    case 'matchEnd':
      msg.result?.youWon ? wins++ : losses++;
      if (current) {
        const st = current.lastState;
        const youRounds = st?.you?.wins ?? null;
        const oppRounds = st?.opp?.wins ?? null;
        console.log(JSON.stringify({
          t: 'blockResult',
          match_id: current.matchId,
          handle: current.handle,
          character: current.character,
          opponent_handle: current.opponentHandle,
          opponent_character: current.opponentCharacter,
          policy_version: current.policyVersion,
          map: current.map,
          round_score: youRounds === null || oppRounds === null ? null : `${youRounds}-${oppRounds}`,
          outcome: msg.result?.youWon ? 'win' : 'loss',
          elo_delta: msg.result?.rating?.delta ?? null,
          decision_counts: current.counts,
        }));
        current = null;
      }
      console.log(`match over — ${msg.result?.youWon ? 'WON' : 'lost'} (record ${wins}-${losses}).`);
      if (wins + losses >= MAX_MATCHES) process.exit(0);
      console.log('requeueing…');
      setTimeout(() => toGame({ t: 'queue', char: CHAR }), 800);
      break;
    case 'error': console.error('server error:', msg.msg); break;
  }
});
console.log(`starting bot: ${args.tcp ? `tcp ${args.tcp}` : `ssh ${USER}@${HOST} play`} as ${CHAR}`);
