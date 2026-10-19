# usage: d3-inject.sh <scene...>  injects the working CSS into the running build (fast loop, no rebuild)
cd "$(dirname "$0")/../../.." && D3_SCENES=src/hawl/tools/d3-scenes.cjs D3_CSS=src/hawl/renderer/d3-surfaces.css node src/hawl/tools/d3-drive.cjs C:/dev/hawl-ws-wt/D3-shots "$@"
