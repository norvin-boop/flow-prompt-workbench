export const modes = {
  dialogue: 'Character dialogue',
  narration: 'Voice-over narration',
  silent: 'No spoken audio'
};

export const demographics = {
  femaleYoung: 'a young adult woman',
  femaleOld: 'an older adult woman',
  maleYoung: 'a young adult man',
  maleOld: 'an older adult man'
};

export const aspectRatios = ['9:16', '16:9', '1:1', '4:5'];

export const stages = [
  { title: 'Character and Location Sheets', note: 'With a saved style selected, Generate Images attaches it and sends the prompt. Review the results before renaming.', actions: [
    ['createSheets', 'Generate Images'],
    ['renameSheets', 'Rename Images']
  ] },
  { title: 'Shot Direction', note: 'Tell the Agent which plan you approve before moving on.', actions: [['plan', 'Draft Shot Direction']] },
  { title: 'Start Frames', note: 'Attach any frame references in Flow. Review the generated frames there.', actions: [
    ['frames', 'Generate Start Frames'],
    ['inBetweenFrames', 'Add 2 More Start Frames in Between Scenes'],
    ['renameFrames', 'Rename Start Frames']
  ] },
  { title: 'Video', note: 'Review takes and leave revision notes in the Flow Agent session.', actions: [
    ['video', 'Generate Videos'],
    ['renameVideos', 'Rename Videos'],
    ['retry', 'Revise Takes With Notes']
  ] },
  { title: 'Delivery', note: 'Verify the approved collection, download it from Flow, and upload to the project folder.', actions: [
    ['collect', 'Collect Approved Videos']
  ] }
];

export const defaultSettings = {
  model: 'veo',
  veoSeconds: '6',
  omniSeconds: '10',
  audio: 'silent',
  demographic: '',
  aspectRatio: '',
  script: '',
  styleId: '',
  uploadFolder: ''
};

const review = 'Use only assets explicitly approved by the specialist in this Flow Agent session or selected in Flow and explicitly confirmed as approved. If the intended assets or their approval are unclear, ask the specialist to select or identify them before changing anything.';

export const templates = {
  createSheets: 'Read the supplied script. Use the attached style reference to guide palette, lighting, texture, shape language, and visual treatment. Identify recurring characters and locations. Generate one reference sheet for each distinct identity or continuity state required by the script. Propose sequential names Char 1, Char 2, and so on for character sheets, and Loc 1, Loc 2, and so on for location sheets. Keep a mapping of the proposed name, what it depicts, and its actual Flow title. Stop for review.',
  renameSheets: 'Rename approved character sheets Char 1, Char 2, and so on. Rename approved location sheets Loc 1, Loc 2, and so on. Follow the mapping agreed in this Agent session. Preserve already assigned numbers and skip name collisions until the specialist resolves them. Report each completed rename.',
  plan: 'Draft shot direction for the production script using the approved character and location sheets. Preserve story beats and continuity. For each clip include scene ID, clip ID, shot IDs, cut times, framing, camera angle and movement, on-screen action, sheet references, and the required opening frame. Use IDs like SC01-SH01 for single-shot Veo clips and SC01-CL01 for multi-shot Omni clips. Flag missing references or timing conflicts. Return the plan for approval before generating media.',
  frames: 'Use the explicitly approved shot plan in this Agent session. Create one opening frame for each planned clip that still needs a frame, using approved sheets and any attached opening-frame references. Match opening pose, composition and continuity. Report the parent clip ID, a stable frame name such as SC01-CL01-F01, and the actual Flow title. Use a fresh suffix for a revision and keep existing images. Stop for review.',
  inBetweenFrames: 'Add exactly two intermediate shot-start frames for each approved multi-shot clip that still needs them. Preserve its approved opening frame and cut order. Choose two distinct existing internal cuts, one near the first third and one near the last third. Match each chosen shot’s opening composition, lens angle, lighting, character identity, blocking and props. Identify the clip, shot ID and exact cut time for each frame. Use names like SC01-CL01-MID01 and SC01-CL01-MID02. Skip clips with fewer than two eligible internal cuts and report why. Keep existing images and stop for review.',
  renameFrames: 'Rename the approved start frames using the clip IDs and frame suffixes from the agreed plan, such as SC01-CL01-F01. Preserve MID01 and MID02 suffixes on approved intermediate frames. Skip ambiguous matches and name collisions. Report what changed.',
  video: 'Use the explicitly approved shot plan and its approved opening frames. Generate one new take per planned clip that still needs a first take. Use the exact approved image for each opening frame. Where supported, use approved intermediate frames as references at their specified cuts. Check that the requested model and duration are supported in Flow. Ask before using a replacement setting or an ambiguous reference. Report clip ID, source frame, take ID such as SC01-CL01-T01, and current Flow title. Stop for review.',
  renameVideos: 'Rename approved videos using their agreed clip IDs and take suffixes, such as SC01-CL01-T01. Preserve distinct take numbers. Skip ambiguous matches or name collisions and report what changed.',
  retry: 'Create a new take only for explicitly flagged videos with revision notes in this Agent session. Keep the previous takes. Use the same approved source frame and clip plan, apply the notes, and assign the next unused take number. If the take, source frame, notes, or desired settings are unclear, ask before generating. Report the old and new take names and stop for review.',
  collect: 'Group the approved final videos into a Flow collection called Approved Videos. Reuse that collection only if it contains no unapproved or unrelated assets. If the collection contains other items, ask before changing it. Report the exact included titles and any missing or ambiguous assets.'
};

const audioDirections = {
  dialogue: 'Character dialogue with lip-sync. Keep the script wording verbatim. Identify the on-screen speaker, exact line, language and start/end time. Direct the speaker’s mouth movements and lip-sync, and keep other characters from mouthing the line. Flag lines that cannot fit the timing for specialist review.',
  narration: 'Voice-over narration. Preserve the exact narration lines and assign them to an off-screen voice with start/end times. On-screen characters act silently without dialogue or lip-sync. Flag narration that cannot fit naturally.',
  silent: 'No spoken audio. Plan visual action without dialogue or narration. Use environment sound where appropriate.'
};

export const audioActions = new Set(['plan', 'video', 'retry']);
const modelActions = new Set(['plan', 'frames', 'inBetweenFrames', 'video', 'retry']);
const reviewActions = new Set(['renameSheets', 'plan', 'frames', 'inBetweenFrames', 'renameFrames', 'video', 'renameVideos', 'collect']);
const planActions = new Set(['frames', 'inBetweenFrames', 'video', 'retry']);
const productionActions = new Set(['createSheets', 'plan', 'frames', 'inBetweenFrames', 'video', 'retry']);

export function migrateSettings(saved = {}) {
  const values = Object.fromEntries(Object.keys(defaultSettings).filter(key => key in saved).map(key => [key, saved[key]]));
  return { ...defaultSettings, ...(saved.speech === true && !('audio' in saved) ? { audio: '' } : {}), ...values };
}

export function presetKey(action, audio) {
  return audioActions.has(action) ? action + ':' + audio : action;
}

export function defaultPreset(action, audio) {
  return templates[action] + (audioActions.has(action) ? '\n\n' + audioDirections[audio] : '');
}

export function getPreset(action, audio, overrides = {}) {
  return overrides[presetKey(action, audio)] || defaultPreset(action, audio);
}

function modelDirection(settings) {
  return settings.model === 'veo'
    ? 'Video route: Veo 3.1 Lite. Generate one clip per shot with no internal cuts. Target roughly five seconds in the edit. Native generation length: ' + settings.veoSeconds + ' seconds.'
    : 'Video route: Omni Flash 1.2. Plan four to five shots per clip, roughly two to three seconds each, with varied angles, framing, and timed cuts. Native generation length: ' + settings.omniSeconds + ' seconds. Ask before changing duration if the selected length is unavailable.';
}

function framingDirection(ratio, action) {
  const crop = ratio === '1:1' || ratio === '4:5';
  if (action === 'createSheets') {
    return 'The final video framing target is ' + ratio + '. Design the reference sheets so the lead’s face, full silhouette, and wardrobe remain usable across shots in that format.';
  }
  if (crop) {
    return 'Final delivery aspect ratio: ' + ratio + '. Plan and generate a 9:16 portrait source for a ' + ratio
      + ' crop in editing. Keep faces, product, text, and essential action inside the centered ' + ratio + ' crop throughout each shot. Flag any framing that will not survive the crop.';
  }
  return 'Aspect ratio: ' + ratio + '. Use that framing consistently for the shot plan, opening frames, and native video. Flag any incompatible reference or model setting before generating.';
}

export function makePrompt(action, settings, style, overrides = {}) {
  if (!(action in templates)) throw new Error('This workflow action is unavailable.');
  if (audioActions.has(action) && !modes[settings.audio]) throw new Error('Choose an audio mode in Project Setup first.');
  const context = [getPreset(action, settings.audio, overrides)];
  if (modelActions.has(action)) context.push(modelDirection(settings));
  if (productionActions.has(action)) {
    if (demographics[settings.demographic]) {
      const continuity = action === 'createSheets' ? 'Apply this to the main character only. Preserve supporting roles from the script.'
        : 'Use the approved matching character sheet and preserve the same identity across shots. Flag a sheet that conflicts with this direction before generating.';
      context.push('Main character: ' + demographics[settings.demographic] + '. ' + continuity);
    }
    if (aspectRatios.includes(settings.aspectRatio)) context.push(framingDirection(settings.aspectRatio, action));
  }
  if (reviewActions.has(action)) context.push(review);
  if (planActions.has(action)) context.push('If an approved plan or needed references cannot be identified in this exact session, or if the approved plan conflicts with the current model, audio, character, or framing instructions, ask the specialist before generating.');
  if (action === 'createSheets' || action === 'plan') {
    context.push(settings.script.trim() ? 'Production script:\n' + settings.script.trim() : 'Use the production script provided in this Agent session. Ask the specialist to supply it if it is missing.');
  }
  if (action === 'createSheets') {
    if (style) context.push('Selected style: ' + JSON.stringify(style.name) + '. Match the reference image attached by the specialist for that style.');
    context.push('If the style reference image is not available here, ask the specialist to attach it before generating.');
  }
  return context.join('\n\n');
}


