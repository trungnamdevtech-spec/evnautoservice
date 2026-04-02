/**
 * pdfjs-dist (kèm theo pdf-parse v2) gán biến toàn cục khi load module (vd. SCALE_MATRIX = new DOMMatrix()).
 * Node.js thuần không có DOMMatrix / ImageData / Path2D — cần stub trước khi import "pdf-parse".
 * Dùng chung cho scripts/docker-verify-runtime.mjs (build Docker).
 */
export function installPdfjsDomPolyfills() {
  const g = globalThis;
  if (typeof g.DOMMatrix === "undefined") {
    g.DOMMatrix = class DOMMatrix {
      constructor() {}
    };
  }
  if (typeof g.DOMMatrixReadOnly === "undefined") {
    g.DOMMatrixReadOnly = g.DOMMatrix;
  }
  if (typeof g.ImageData === "undefined") {
    g.ImageData = class ImageData {
      constructor() {}
    };
  }
  if (typeof g.Path2D === "undefined") {
    g.Path2D = class Path2D {
      constructor() {}
    };
  }
}

installPdfjsDomPolyfills();
