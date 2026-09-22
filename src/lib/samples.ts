import type { Document } from './types';

export const samples: Document[] = [
  { id: 'sample-operations', title: 'Installation operations.md', sample: true, text: 'The installation opens daily at 09:00 and closes at 19:00. The playback computer starts automatically after power is restored. It launches the installation in kiosk mode and loads the last approved content package.\n\nIf the OSC connection is lost, the installation continues playing the local idle sequence. It attempts to reconnect every 5 seconds. Incoming state updates are applied idempotently, so repeated packets do not trigger duplicate animations.\n\nTo shut down, use the physical power button once. The system finishes the active capture, releases its render textures, and exits. Never remove power while the printer is processing a job.' },
  { id: 'sample-capture', title: 'Capture and printing.md', sample: true, text: 'Captures are rendered at 2400 by 3600 pixels and saved as PNG files. The print queue is limited to 12 jobs. If the queue is full, the interface displays a busy message and the visitor can try again later.\n\nWhen the printer disconnects, pending jobs remain in the queue. The print service retries the connection every 10 seconds. A job is removed only after the printer confirms completion.\n\nVisitor captures are stored locally for 24 hours and then automatically deleted. No captures are uploaded to a remote service. Operators can export an individual capture before it expires.' },
  { id: 'sample-hardware', title: 'Hardware specification.md', sample: true, text: 'The exhibition uses a Windows playback computer with 16 GB of RAM and an NVIDIA graphics card. The display wall runs at 3840 by 1080 pixels at 60 Hz. A separate tablet controls content selection over the local network.\n\nThe tablet sends OSC messages to UDP port 9000. The playback computer sends status updates on port 9001. Both devices use static IP addresses on a dedicated wired network.\n\nThe approved Unity build uses URP with a fixed render scale of 1.0. Quality settings are locked at startup. The installation targets a stable 60 frames per second.' }
];
export const exampleQuestions = [
  'What happens when the OSC connection is lost?',
  'How long are visitor captures stored?',
  'Does the installation support facial recognition?'
];
