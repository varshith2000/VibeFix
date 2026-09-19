/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#0b0f17",
          900: "#111827",
          800: "#1f2937",
          700: "#374151",
        },
      },
    },
  },
  plugins: [],
};
