import localFont from "next/font/local";

export const fontSans = localFont({
  src: [
    { path: "../../public/brand/kod-bzh/fonts/open-sauce-sans-400.ttf", weight: "400" },
    { path: "../../public/brand/kod-bzh/fonts/open-sauce-sans-500.woff2", weight: "500" },
    { path: "../../public/brand/kod-bzh/fonts/open-sauce-sans-600.woff2", weight: "600" },
    { path: "../../public/brand/kod-bzh/fonts/open-sauce-sans-700.woff2", weight: "700" },
  ],
  variable: "--font-brand-sans",
  display: "swap",
});

export const fontMono = localFont({
  src: [
    { path: "../../public/brand/kod-bzh/fonts/ibm-plex-mono-400.woff2", weight: "400" },
    { path: "../../public/brand/kod-bzh/fonts/ibm-plex-mono-500.woff2", weight: "500" },
  ],
  variable: "--font-brand-mono",
  display: "swap",
});

export const fontDisplay = localFont({
  src: "../../public/brand/kod-bzh/fonts/NewAmsterdam.ttf",
  variable: "--font-brand-display",
  display: "swap",
});

export const fontVariables = `${fontSans.variable} ${fontMono.variable} ${fontDisplay.variable}`;
