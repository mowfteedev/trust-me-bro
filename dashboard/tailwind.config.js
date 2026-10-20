/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Preserve the existing terminal palette while upgrading the compiler.
        cyan: { 300: '#67e8f9', 400: '#22d3ee', 500: '#06b6d4' },
        emerald: { 400: '#34d399', 500: '#10b981' },
        red: { 300: '#fca5a5', 400: '#f87171', 500: '#ef4444', 950: '#450a0a' },
        neutral: { 100: '#f5f5f5', 200: '#e5e5e5', 300: '#d4d4d4', 400: '#a3a3a3', 700: '#404040', 800: '#262626', 900: '#171717' },
        slate: { 50: '#f8fafc', 800: '#1e293b' },
        brand: {
          50: '#ecfeff',
          100: '#cffafe',
          500: '#06b6d4',
          600: '#0891b2',
          700: '#0e7490',
        },
        surface: {
          base: '#090d16',
          raised: '#111827',
          card: '#162032',
          overlay: '#1e293b',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
    },
  },
  plugins: [],
}
