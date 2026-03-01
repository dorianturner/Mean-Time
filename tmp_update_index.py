from pathlib import Path

path = Path('/home/ubuntu/Mean-Time/backend/src/index.ts')
text = path.read_text()

text = text.replace("import { startSepoliaWatcher } from './sepoliaWatcher.js'\n", "")
text = text.replace("  const stopSepoliaWatcher = startSepoliaWatcher(ctx, store)\n", "")
text = text.replace("    stopSepoliaWatcher()\n", "")

path.write_text(text)
print('updated index.ts')
