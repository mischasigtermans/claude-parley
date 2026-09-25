import {
  describeParticipants,
  isGrounder,
  postMessage,
  renderMessages,
  unseenBy,
  writeRoom,
  type RoomState,
} from '../registry/rooms.js';

export type AskFn = (peer: string, question: string) => Promise<string>;

export interface RunRoundsInput {
  state: RoomState;
  rounds: number;
  ask: AskFn;
}

export interface RunRoundsResult {
  state: RoomState;
  roundsRun: number;
}

const PASS = /^\s*PASS\b/i;

export function isPass(answer: string): boolean {
  return PASS.test(answer);
}

/**
 * Grounders speak first, so the advisors' turns this round already see the
 * corrections to last round's claims. Within each group, participants
 * @-mentioned in the pending delta go first, so an addressed question gets its
 * answer before the room moves on. Stable otherwise.
 */
export function speakingOrder(state: RoomState): string[] {
  const mentioned = new Set<string>();
  for (const p of state.participants) {
    for (const m of unseenBy(state, p)) {
      for (const q of state.participants) {
        if (q !== m.from && new RegExp(`@${escapeRegExp(q)}\\b`).test(m.text)) mentioned.add(q);
      }
    }
  }
  const rank = (p: string) => (isGrounder(state, p) ? 0 : 2) + (mentioned.has(p) ? 0 : 1);
  return [...state.participants].sort((a, b) => rank(a) - rank(b));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function others(state: RoomState, me: string): string {
  return state.participants.filter((p) => p !== me).map((p) => (isGrounder(state, p) ? `${p} (grounding)` : p)).join(', ');
}

function projectAccess(state: RoomState): string {
  if (!state.projectPath) return '';
  return (
    `The convening project lives at ${state.projectPath}. You may read its files to check facts before you assert them; cite file paths when you do. Do not modify anything there. `
  );
}

const GROUNDER_ROLE =
  'Your role is grounding, not advising: you are the project the others are talking about, and you have its code, docs and data in front of you. ' +
  'Do not take a position on the decision itself.';

export function blindPrompt(state: RoomState, me: string, totalRounds: number): string {
  const head =
    `[parley room "${state.room}" · round 1 of ${totalRounds} · blind round]\n` +
    `You are "${me}", one of ${state.participants.length} participants in a group discussion convened by ${state.convenedBy}. ` +
    `The others: ${others(state, me)}. This first round is blind: everyone answers independently and sees the others' answers next round.\n\n` +
    `Question:\n${state.question}\n\n`;
  if (isGrounder(state, me)) {
    return (
      head +
      `${GROUNDER_ROLE} Check every factual claim the question makes about your project against the actual code and data. ` +
      `Correct what is wrong, cite the file (and line where useful) for what you confirm, and name the facts the question depends on but doesn't state. ` +
      `Keep it under 300 words.`
    );
  }
  return (
    head +
    projectAccess(state) +
    `Answer in your own voice, from your own expertise. Take a clear position and give your reasons. Be concrete. Keep it under 300 words. Do not address the others yet.`
  );
}

export function roundPrompt(state: RoomState, me: string, delta: string, totalRounds: number): string {
  const head =
    `[parley room "${state.room}" · round ${state.round} of ${totalRounds}]\n` +
    `You are "${me}". Participants: ${describeParticipants(state)}. Question under discussion:\n${state.question}\n\n` +
    `Since your last turn:\n\n${delta}\n\n`;
  if (isGrounder(state, me)) {
    return (
      head +
      `${GROUNDER_ROLE} Verify the factual claims the others made about your project: confirm or correct each one with a file reference, and answer any question addressed to you with @${me}. ` +
      `Where someone proposes a check or measurement you can run now, run it and report the result. Keep it under 250 words. If nothing needs verifying, reply with exactly: PASS`
    );
  }
  return (
    head +
    projectAccess(state) +
    `Reply to the discussion. Agree or disagree explicitly, sharpen or challenge specific points, and address someone with @alias when you're speaking to them. ` +
    `Don't restate what you or others already said. Keep it under 250 words. If you have nothing to add, reply with exactly: PASS`
  );
}

export async function runRounds(input: RunRoundsInput): Promise<RunRoundsResult> {
  const { state, ask } = input;
  if (state.status === 'closed') {
    throw new Error(`parley: room "${state.room}" is closed.`);
  }
  const totalRounds = state.round + input.rounds;
  let roundsRun = 0;

  while (state.round < totalRounds) {
    state.round += 1;
    state.status = 'open';
    await writeRoom(state);
    roundsRun += 1;

    if (state.round === 1) {
      const answers = await Promise.all(
        state.participants.map((p) => safeAsk(ask, p, blindPrompt(state, p, totalRounds))),
      );
      for (let i = 0; i < state.participants.length; i++) {
        const a = answers[i];
        await postMessage(state, state.participants[i], a.text, a.failed);
      }
      continue;
    }

    let allPassed = true;
    for (const p of speakingOrder(state)) {
      const delta = unseenBy(state, p);
      if (delta.length === 0) continue;
      const shownUpTo = state.messages.at(-1)?.seq ?? 0;
      const a = await safeAsk(ask, p, roundPrompt(state, p, renderMessages(delta), totalRounds));
      state.seen[p] = shownUpTo;
      const passed = a.failed || isPass(a.text);
      if (!passed) allPassed = false;
      await postMessage(state, p, passed && !a.failed ? 'PASS' : a.text, passed);
    }
    if (allPassed) {
      state.status = 'converged';
      await writeRoom(state);
      break;
    }
  }
  return { state, roundsRun };
}

async function safeAsk(
  ask: AskFn,
  peer: string,
  prompt: string,
): Promise<{ text: string; failed: boolean }> {
  try {
    return { text: await ask(peer, prompt), failed: false };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { text: `[no answer: ${detail}]`, failed: true };
  }
}
