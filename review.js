import { aspectRatios, demographics } from './prompts.js';

export const checkpoints = [
  { id: 'sheets', label: 'Character and location sheets', next: 'plan', checklist: 'Verify the script’s recurring characters and locations are covered and visually consistent with the style reference. Identify the usable sheet titles.' },
  { id: 'plan', label: 'Shot direction', next: 'frames', checklist: 'Verify the requested model, clip boundaries, durations, camera direction, references and audio treatment. Identify the exact plan revision or title and every clip ID.' },
  { id: 'frames', label: 'Start frames', next: 'video', checklist: 'Verify coverage of the approved clip IDs, continuity and that each image works as an opening frame. Identify the usable frame titles and their clip IDs.' },
  { id: 'videos', label: 'Video takes', next: 'collect', checklist: 'Watch the relevant videos and check continuity, motion, framing, timing and speech or lip-sync if applicable. Identify the exact approved take titles.' }
];

export function makeReviewPacket(provider, request, project, evidence) {
  const step = checkpoints.find(item => item.id === request.stage);
  const audio = project.audio || 'unset';
  return [
    'Act as the delegated Google Flow production reviewer in ' + provider + '. Decide whether the next stage should proceed.',
    'Review ID: ' + request.id + '\nCheckpoint: ' + step.id + '\nNext action if approved: ' + step.next,
    'Production settings: ' + project.model + ', ' + (project.model === 'veo' ? project.veoSeconds : project.omniSeconds) + ' seconds, audio ' + audio + '.',
    demographics[project.demographic] ? 'Main character: ' + demographics[project.demographic] + '.' : '',
    aspectRatios.includes(project.aspectRatio) ? 'Final delivery aspect ratio: ' + project.aspectRatio + '.' : '',
    step.checklist,
    'Use only the actual Flow evidence supplied or directly visible in the authorized project. Ask for missing assets, screenshots, video, or context. Use hold for insufficient evidence or quality issues. Use stop for any failed generation/request, moderation, quota, rate limit, sign-in interruption, ambiguous submission, or a Flow error. Never retry or resubmit.',
    'Return exactly one JSON object in this shape. Keep the review ID and checkpoint unchanged. For advance, approved must contain at least one exact visible title or identifier. Include associations such as clip ID to frame title when relevant. For hold or stop, approved must be empty.',
    JSON.stringify({ reviewId: request.id, checkpoint: step.id, decision: 'advance|hold|stop', reason: 'One specific reason', approved: [] }),
    project.script.trim() ? 'Script supplied by the specialist:\n' + project.script.trim() : '',
    evidence.trim() ? 'Review evidence supplied by the specialist:\n' + evidence.trim() : 'Review evidence must be supplied separately or visible in the authorized browser.'
  ].filter(Boolean).join('\n\n');
}

export function parseDecision(input, run) {
  if (run?.state !== 'review') throw new Error('Request a review before applying a decision.');
  let result;
  try {
    result = JSON.parse(input.trim().replace(/^\x60\x60\x60(?:json)?\s*([\s\S]*?)\s*\x60\x60\x60$/i, '$1'));
  } catch {
    throw new Error('Paste the reviewer’s JSON decision.');
  }
  if (!result || result.reviewId !== run.id || result.checkpoint !== run.stage) {
    throw new Error('This decision belongs to a different review or checkpoint.');
  }
  if (!['advance', 'hold', 'stop'].includes(result.decision) || typeof result.reason !== 'string'
      || !result.reason.trim() || result.reason.length > 1500 || !Array.isArray(result.approved)
      || result.approved.length > 200 || result.approved.some(item => typeof item !== 'string' || !item.trim() || item.length > 240)) {
    throw new Error('The decision must include a valid choice, reason, and approved list.');
  }
  if (Boolean(result.approved.length) !== (result.decision === 'advance')) {
    throw new Error('An advance decision requires exact approved references. A hold or stop requires an empty list.');
  }
  return { ...result, reason: result.reason.trim(), approved: [...new Set(result.approved.map(item => item.trim()))] };
}

export function reviewedPrompt(prompt, stage, approved) {
  const approval = stage === 'plan' ? 'I approve the specific shot plan listed below for production.'
    : stage === 'frames' ? 'I approve the exact opening frames listed below for video generation.'
    : stage === 'videos' ? 'I approve the exact video takes listed below for delivery.'
    : 'I approve the exact character and location sheets listed below for shot planning.';
  return [
    approval + ' These are delegated approval decisions from the project reviewer. Use only exact matches in this session. If a reference cannot be matched unambiguously, stop and ask. Any missing item stays on hold.',
    JSON.stringify(approved),
    prompt,
    'This is a single request. If any work fails, report the stop and leave partial results in place. Do not retry, recreate, change the model, or automatically start the next stage.'
  ].join('\n\n');
}

export function browserRunBrief(provider, project, stage, prompts) {
  const start = checkpoints.find(item => item.id === stage);
  return [
    'You are ' + provider + ', the delegated Flow production reviewer and browser operator.',
    'If you have interactive browser tools and the specialist has authorized this run, use only the currently open Google Flow project and its existing Agent session. If you do not have browser tools, stop and ask for Flow evidence so you can provide a review decision instead.',
    'Start by reviewing ' + start.label + '. Inspect the actual artifacts and decide whether the next stage is ready. Proceed only on visible evidence. A quality concern or missing evidence means hold and report it. Do not seek approval for a stage that clearly meets its checklist under the authorized run.',
    'Use the visible Agent composer only. Send at most one Agent request per approved checkpoint, one request in flight at a time. List the exact assets or plan you are approving in the prompt. Preserve any pre-existing draft and stop if the project/session changes, the composer is ambiguous, or you cannot confidently identify the approved artifacts.',
    'Wait for a visible successful result before the next checkpoint. On the first error, failed or partial result, moderation, quota, rate limit, authentication interruption, timeout, or uncertain acknowledgement, STOP the entire run. Never retry, click Send again, switch accounts/models, reload to bypass a limit, or run parallel requests. Report the checkpoint, evidence, and exact error to the specialist. Stop after creating the collection; downloads and uploads are handled by the specialist.',
    ...checkpoints.slice(checkpoints.indexOf(start)).map((step, index) =>
      'Checkpoint ' + (index + 1) + ' — ' + step.label + '\n' + step.checklist + '\n\nIf approved, use this instruction once, scoped to the evidence you verified:\n' + prompts[step.next]),
    project.script.trim() ? 'Production script:\n' + project.script.trim() : ''
  ].filter(Boolean).join('\n\n');
}

