# Flow Prompt Workbench 1.4.0

A Chrome and Microsoft Edge sidebar with saved Google Flow Agent prompts.

## Install or update

1. Extract the ZIP to a permanent folder. To update an unpacked installation, replace its files in the same folder, then use **Reload** on the extension’s card. Keeping the folder preserves the browser’s extension identity and local data.
2. For a new installation, open `chrome://extensions` or `edge://extensions`. Enable **Developer mode**, click **Load unpacked**, and select the folder containing `manifest.json`.
3. Open or refresh a Google Flow project and turn on **Agent**. Expand its panel. Open **Flow Prompt Workbench** from the browser’s Extensions menu. The sidebar indicator turns green when it finds the Agent composer.
4. If the indicator is red, click **Link Agent box**, then click inside the Agent prompt field in Flow within 30 seconds. The sidebar confirms when the composer is ready. **Prompt Preview** also offers **Copy Prompt**. Existing Flow drafts are preserved.

## Project setup

**Inputs** contains Project Setup and the ordered Workflow. **Presets & Settings** contains AI Review & Automation, Style Library, Edit Presets, and Appearance. **Output** shows the active project’s status and delivery file.

- Choose the video model, clip length and audio mode. **Character dialogue** directs on-screen speech with lip-sync. **Voice-over narration** directs off-screen narration and silent character performance. **No spoken audio** leaves out dialogue and narration. A project with the old combined speech checkbox enabled asks for an explicit audio choice.
- **Demographic (MC)** sets the lead as a young or older adult woman or man. **Aspect Ratio** can request native 9×16 or 16×9 framing, or a 9×16 source composed for a 1×1 or 4×5 crop in editing. These selections carry into the relevant Flow prompts and AI reviews. Existing projects keep script-defined casting and Flow’s framing setting until you select an option.
- Enter the script or supply it in the Flow Agent session.
- Use **Style Library** to save a named image such as Papercraft or Claymation, then select it in **Visual style**. Click the thumbnail or the library’s **View** button to inspect it with Fit, Actual size, zoom, and drag-to-pan controls. Styles are stored in this browser profile and are available across its Flow projects.
- Add a Google Drive folder URL under **Upload folder** to prefill **Upload link here** in Output. Either field updates the same project setting.

## Workflow

1. **Character and Location Sheets.** With a saved style selected and an empty composer in the expanded Flow Agent panel, click **Generate Images**. If Flow puts the image in project assets, Workbench selects that upload through **Add ingredients**. It sends one request after it verifies the ingredient in the draft. Flow may still ask you to confirm generation credits. If attachment verification fails, Workbench leaves the prompt in the Agent when possible so you can choose the image and send it. With no saved style selected, **Generate Images** prepares a draft. Review the resulting sheets and tell the Agent which you approve. Rename the approved assets with the agreed numbering, such as **Char 1**, **Char 2**, **Loc 1**, and **Loc 2**.
2. **Shot Direction.** Draft the plan for Veo or Omni and the chosen audio mode. Tell the Agent which plan you approved in that same session.
3. **Start Frames.** Attach any extra opening-frame references in Flow. Generate remaining frames for the approved plan. Use **Add 2 More Start Frames in Between Scenes** to request two frames at existing internal cuts per multi-shot clip. Review and confirm approved frames before renaming.
4. **Video.** Generate remaining first takes from approved start frames. Tell the Agent which takes are approved and which need revisions. Give the exact title and notes for each flagged take. Use **Revise Takes With Notes** to request fresh versions.
5. **Delivery.** Ask the Agent to collect the approved finals. Verify and download the collection in Flow, then add it under Output.

The remaining workflow buttons prepare drafts. Review and send them in Flow. Keep approvals, selections, and revision notes in the same Agent session.

## Output and delivery

1. **Projects** shows cards for open and previously seen Flow projects in this browser profile. Open tabs can show visible Agent activity and a media thumbnail when available. Click a card to switch to the project’s tab or reopen it. The card shows the Google account Flow exposes, or the account slot in the project URL. Use **Label active project’s account** to set an explicit label. Project names, links, and account labels are stored locally. Refresh Flow tabs that were already open when you updated the extension so Workbench can discover them. **Delivery** is for the active project.
2. **Delivery ZIP** accepts the downloaded approved ZIP or one or more approved MP4, MOV, WebM, or M4V files. Workbench can package selected videos up to 4 GB into a ZIP. **Download ZIP** retrieves the project’s attached copy. The ZIP stays in this browser profile and is associated with that Flow project.
3. Paste the destination Drive folder URL in **Upload link here** and click **Send**. On first use, allow Workbench access to Google Drive. It opens the folder and uses that account’s **New → File upload** command. The progress bar shows ZIP preparation and Drive’s reported upload progress, or an indeterminate state when Drive supplies no percentage. **View Drive upload** opens the upload tab. The bar reaches 100% once Workbench sees a matching receipt or the ZIP in that folder.
4. Direct Send supports ZIPs up to 512 MB. For a larger ZIP, unsupported Drive interface, or unavailable browser permission, click **Download ZIP** and use **Open folder** to upload manually. If a previous submission is unconfirmed, check Drive for the file before allowing another send. Workbench does not automatically repeat the upload.

## AI Review & Automation

**Browser-capable assistant.** Choose the first checkpoint and select **Copy Browser Automation Brief**. Paste it into an assistant that has browser controls, then authorize the run in that assistant. The brief directs the assistant to assess the visible outputs, decide whether to proceed, send one Flow request per approved checkpoint, and stop on the first failure or uncertain result. The external assistant controls the browser and is responsible for following the brief. Delivery remains in Output.

**Chat-only assistant.** Open **Chat-only review relay** and choose the checkpoint. Copy the review request and supply the relevant Flow evidence to your assistant, including actual images or video for visual review. Paste the assistant’s returned JSON decision into **Assistant’s decision**, then click **Apply Decision**.

- **Advance** scopes the next Flow prompt to the assets or plan the assistant approved. With **Send an approved next step once** enabled, the extension attempts one submission through the expanded Agent’s visible Send control. With the option off, it prepares a draft for you to send.
- **Hold** leaves the run at the same checkpoint. Send additional evidence to the reviewer before applying a new decision.
- **Stop** ends the relay. A visible Flow error, interrupted request, or uncertain submission also stops it. Check the Flow Agent before starting another run. The extension does not retry a submission.

The relay uses your existing assistant chat through the clipboard. Open a review at the next checkpoint only after Flow shows the result of the previous request. The extension cannot monitor failures Flow does not expose in the visible interface.

## Presets and appearance

**Edit Presets** saves your preferred wording. Shot direction, video generation, and revision prompts have independent presets for each audio mode. The extension adds the relevant project context when preparing a prompt.

Choose **System**, **Light**, or **Dark** under **Appearance**. Appearance, presets, project settings, and style images are saved locally in the browser profile. Chrome and Edge each maintain their own library.

