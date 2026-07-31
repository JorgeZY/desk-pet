# Notices

This project is an original implementation inspired by the product architecture
of [OpenBMB/MiniCPM-Desk-Pet](https://github.com/OpenBMB/MiniCPM-Desk-Pet).
No source code or artwork from that AGPL-3.0-only repository is included here.

Runtime and model dependencies are obtained separately:

- `llama.cpp` is maintained by the ggml-org contributors and distributed under
  its own MIT license.
- The replaceable default MiniCPM5-1B model weights are maintained by OpenBMB.
  Other selected models have their own licenses; review each model card before
  downloading or redistributing weights.
- Electron, React, Vite, and other npm dependencies retain their respective
  licenses.
- The local speech flow is based on the architecture of
  [JorgeZY/opencode-stt](https://github.com/JorgeZY/opencode-stt). No Python
  runtime or clipboard automation from that project is bundled.
- `sherpa-onnx-node` and its native runtime are Apache-2.0. `uiohook-napi` is
  MIT and `node-cpal` is ISC; their notices remain with the npm packages.
- Streaming Paraformer and SenseVoice weights are downloaded from the official
  sherpa-onnx releases into `models/speech/`. Model weights retain their own
  upstream terms and are not redistributed in this repository.
