import { openableUrl } from './link-detection';

const worker = new Worker('terminal-worker.js');
worker.onmessage = (event) => {
  const { url } = event.data; // $ Source
  window.open(url, '_blank'); // $ Alert
  const checked = openableUrl(url);
  if (checked !== null) window.open(checked, '_blank', 'noopener');
  window.open('https://merkur.sh/docs', '_blank');
};

const { port1 } = new MessageChannel();
port1.addEventListener('message', (event) => {
  location.href = event.data.target; // $ Alert
});
