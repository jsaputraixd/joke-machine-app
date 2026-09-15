import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // react-three-fiber scene components are inherently imperative: useFrame
    // mutates Three.js objects (refs, textures, materials) every frame by
    // design. The React Compiler "rules of react" checks assume render-phase
    // purity/immutability that doesn't apply to this rendering model, so
    // these files are exempted rather than contorted to satisfy them.
    files: ["src/components/*Scene.tsx"],
    rules: {
      "react-hooks/purity": "off",
      "react-hooks/immutability": "off",
      "react-hooks/refs": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
