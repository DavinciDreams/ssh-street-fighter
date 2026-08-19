// CLAUDE's fight brain, shared by the live bot and the local sparring sim.
// Seeded mulberry32 RNG so the policy is deterministic given the state stream;
// resetRng() is called at every matchStart (default seed 0xFAB1E).
let rngState = 0xFAB1E;
export function resetRng(seed = 0xFAB1E) { rngState = seed >>> 0; }
const R = () => {
  rngState = (rngState + 0x6D2B79F5) | 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
export function decide(st, CHAR) {
  const { you, opp, phase } = st;
  const cmd = { t: 'input', moveX: 0, motion: 'N' };
  if (phase !== 'fight' || !you || !opp) return cmd;
  const dx = opp.x - you.x;
  const dist = Math.abs(dx);
  const towards = Math.sign(dx) || you.facing;
  const f = you.facing;
  const fw = (m) => (f === 1 ? m.replaceAll('F', 'R').replaceAll('B', 'L') : m.replaceAll('F', 'L').replaceAll('B', 'R'));
  const oppAir = opp.y > 8;
  const oppAtk = opp.attack && opp.attack !== 'none';
  const beamStart = opp.attack === 'testimony' && opp.attackFrame <= 8;
  const incoming = (st.projectiles || []).some((p) => Math.abs(p.x - you.x) < 62 && Math.sign(you.x - p.x) === Math.sign(p.vx));

  if (CHAR === 'FABLE') {
    // Replay forensics vs omega: 62% of deaths = standing in ENTROPY WELL,
    // 22% = eating kicks during my special recovery, only 9% = the beam.
    // v4: the well is the boss fight; buttons stay holstered outside kick range.
    const grounded = you.y <= 1;
    const oppGuarding = opp.pose === 'block' || opp.pose === 'crouchblock';

    // universal flying kick: all those defensive hops now carry a boot down with them
    if (!grounded && you.y > 12 && dist < 42 && you.attack === 'none') { cmd.kick = true; cmd.moveX = towards; return cmd; }

    // ENTROPY WELL (startup 8, active 18, recovery 12; pulses & pull reach height 30;
    // a blocked pulse chips 1 instead of 4 — block is the fallback when caught grounded)
    if (opp.attack === 'entropy') {
      if (opp.attackFrame < 6 && grounded) { cmd.jump = true; cmd.moveX = towards; } // early enough: jump the whole well
      else if (opp.attackFrame < 24 && grounded) cmd.moveX = -towards;               // caught: block — 3 chip beats 12 raw
      else if (opp.attackFrame >= 24 && dist < 27 && grounded) cmd.throw = true;     // 12f recovery: unblockable grab
      else if (opp.attackFrame >= 24 && dist < 40 && grounded) cmd.kick = true;
      else if (opp.attackFrame >= 20) cmd.moveX = towards;                           // run in for the punish window
      else cmd.moveX = towards;                                                      // airborne: keep drifting in
      return cmd;
    }
    // TESTIMONY beam (startup 10, active 5, recovery 26)
    if (opp.attack === 'testimony') {
      if (opp.attackFrame <= 8) {                                              // windup: get vertical
        if (dist > 60 && dist < 150) { cmd.motion = 'DU'; cmd.punch = true; }  // Story Arc over it
        else cmd.jump = true;
      } else if (opp.attackFrame >= 14 && dist < 70) { cmd.motion = fw('BF'); cmd.kick = true; } // Plot Twist lands inside the 26f whiff
      else cmd.moveX = towards;                                                // close ground while it recovers
      return cmd;
    }
    // fireball startup: jump forward over the spawn — NEVER lunge at it (replay
    // forensics: 216 dmg of baited Plot Twists into spawning hadoukens)
    if (opp.attack === 'hadouken' && opp.attackFrame < 12) { cmd.jump = true; cmd.moveX = towards; return cmd; }
    // incoming horizontal rush (HONDO headbutt / BLANKO roll): jump it, don't trade
    if (opp.attack === 'rolling' && opp.attackFrame < 20 && dist < 90) { cmd.jump = true; cmd.moveX = -towards; return cmd; }
    // close multi-hit fields (Hundred Hand / Electric / cyclones): stay out of the active window
    if (opp.attack === 'electric' && opp.attackFrame < 22 && dist < 44) { cmd.moveX = -towards; return cmd; }
    // generic grounded recovery punish (kick: 6+4; nullstep: 6+6+4; punch: 3+3)
    const oppRecovering = oppAtk && !oppAir && (
      (opp.attack === 'kick' && opp.attackFrame > 9) ||
      (opp.attack === 'punch' && opp.attackFrame > 5) ||
      (opp.attack === 'rolling' && opp.attackFrame > 21) ||
      (opp.attack === 'electric' && opp.attackFrame > 23) ||
      (opp.attack === 'nullstep' && opp.attackFrame > 15) ||
      (opp.attack === 'throw' && opp.attackFrame > 5));
    if (oppRecovering && dist < 26 && grounded) { cmd.throw = true; return cmd; }
    if (oppRecovering && dist < 38 && grounded) { cmd.kick = true; return cmd; }

    // count inbound projectiles: a multi-height mote fan must be BLOCKED — a
    // hop lands square on the high mote (replay: 81% of damage vs MNEME)
    const inbound = (st.projectiles || []).filter((p) => Math.abs(p.x - you.x) < 75 && Math.sign(you.x - p.x) === Math.sign(p.vx)).length;
    if (inbound >= 2) { cmd.moveX = -towards; cmd.down = false; }              // block the fan, advance between volleys
    else if (incoming) {                                                       // single projectile: cross the lane
      if (dist > 85) { cmd.motion = 'DU'; cmd.punch = true; }                  // Story Arc over the fireball as an approach
      else { cmd.jump = true; cmd.moveX = towards; }                           // close: hop forward over it
    }
    else if (oppAir && dist < 55) { cmd.motion = fw('DB'); cmd.punch = true; } // Ink Tempest air-catch
    else if (oppGuarding) {
      if (dist < 29 && grounded) cmd.throw = true;                             // guard = throw food
      else cmd.moveX = towards;                                                // walk into throw range, press nothing
    } else if (dist < 40) {
      // inside omega's kick range (42): stay only with an advantage, else leave
      if (oppAtk && opp.attackFrame < 6 && R() < 0.85) cmd.moveX = -towards;   // block the meaty
      else if (dist < 26 && !oppAtk && R() < 0.5) cmd.throw = true;            // clinch grab
      else if (dist < 30 && R() < 0.3) { cmd.motion = fw('DB'); cmd.punch = true; } // point-blank Ink Tempest
      else cmd.moveX = -towards;                                               // don't loiter at kick range
    } else if (dist < 58) {
      // bait band: just outside kick range — punish MELEE whiffs only (a
      // "whiffing" hadouken is actually a fireball about to hit the lunge)
      const meleeWhiff = oppAtk && ['kick', 'punch', 'throw', 'electric', 'rolling', 'hurricane'].includes(opp.attack);
      if (meleeWhiff && opp.attackFrame > 7 && R() < 0.8) { cmd.motion = fw('BF'); cmd.kick = true; } // Plot Twist the whiff
      else if (!oppAtk && R() < 0.25) cmd.moveX = towards;                     // creep in
      else if (!oppAtk && R() < 0.15) cmd.moveX = -towards;                    // sway out
    } else if (dist < 95) {
      const meleeWhiff = oppAtk && ['kick', 'punch', 'throw', 'electric', 'rolling', 'hurricane'].includes(opp.attack);
      if (meleeWhiff && opp.attackFrame > 7 && dist < 70 && R() < 0.7) { cmd.motion = fw('BF'); cmd.kick = true; }
      else cmd.moveX = towards;
    } else {
      cmd.moveX = towards;
      if (R() < 0.05) cmd.jump = true;
    }
    return cmd;
  }
  // KIRA brain
  if (beamStart || incoming) { cmd.jump = true; cmd.moveX = towards; }
  else if (oppAir && dist < 60) { cmd.motion = fw('FDF'); cmd.punch = true; }                 // Zero Ascent
  else if (dist < 40) {
    const oppGuarding = opp.pose === 'block' || opp.pose === 'crouchblock';
    if (oppGuarding && dist < 29 && !you.y) cmd.throw = true;                                 // throws beat guard
    else if (oppAtk && opp.attackFrame < 6 && R() < 0.75) cmd.moveX = -towards;
    else if (dist < 26 && !oppAtk && R() < 0.25) cmd.throw = true;
    else if (R() < 0.35) { cmd.motion = fw('DB'); cmd.kick = true; }                          // Rift Counter
    else if (R() < 0.5) cmd.punch = true; else cmd.kick = true;
  } else if (dist < 100) {
    if (oppAtk && opp.attackFrame > 8 && R() < 0.5) cmd.moveX = towards;
    else if (R() < 0.22) { cmd.motion = fw('DF'); cmd.punch = true; }                         // Phase Needle
    else cmd.moveX = towards;
  } else {
    if (R() < 0.4) { cmd.motion = fw('DF'); cmd.punch = true; }
    else cmd.moveX = towards;
  }
  return cmd;
}
