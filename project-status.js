export const projectDeliveryKey = key => 'flow-project-delivery:' + key;

const labels = {
  createSheets: 'Generating assets',
  renameSheets: 'Organizing sheets',
  plan: 'Drafting shot direction',
  frames: 'Generating start frames',
  inBetweenFrames: 'Generating in-between frames',
  renameFrames: 'Organizing start frames',
  video: 'Generating videos',
  renameVideos: 'Organizing videos',
  retry: 'Generating revised videos',
  collect: 'Collecting approved videos'
};

export function projectName(title) {
  return title?.replace(/^Google Flow(?:\s*[-–—|:]\s*|\s*$)/i, '').trim() || 'Flow project';
}

export function describeProject(context, deliveryState) {
  if (deliveryState === 'uploading') return { label: 'Uploading ZIP', note: 'Waiting for Drive confirmation.', color: 'working' };
  if (context.error) return { label: 'Needs Attention', note: context.error, color: 'error' };
  if (context.busy) {
    return { label: labels[context.activity?.action] || 'Flow is working', note: 'Flow reports activity in the Agent panel.', color: 'working' };
  }
  if (deliveryState === 'uploaded') return { label: 'Uploaded', note: 'The attached ZIP was confirmed in Drive.', color: 'success' };
  if (deliveryState === 'check' || deliveryState === 'failed') return { label: 'Check Drive', note: 'Check the destination folder before sending again.', color: 'error' };
  if (deliveryState === 'ready') return { label: 'Ready to Deliver', note: 'The approved ZIP is attached to this project.', color: 'success' };
  if (context.activity?.finished) return { label: 'Review Flow Results', note: 'Flow is no longer reporting activity. Review its results.' };
  if (context.activity?.action) {
    return context.activity.started
      ? { label: 'Check Flow', note: 'Check the Agent for the result.' }
      : { label: 'Prompt Prepared', note: 'Send the draft in Flow or check the Agent for an update.' };
  }
  return { label: 'Awaiting production', note: 'Follow the workflow in Inputs.' };
}

