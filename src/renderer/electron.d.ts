// Electron-specific CSS property augmentation
import "react";

declare module "react" {
  interface CSSProperties {
    WebkitAppRegion?: "drag" | "no-drag";
  }
}
