/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    __dirname + '/index.html',
    __dirname + '/src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'Arial', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
