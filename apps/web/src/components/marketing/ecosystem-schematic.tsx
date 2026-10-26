export function EcosystemSchematic() {
  return (
    <div
      className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-[0.07]"
      aria-hidden
    >
      <svg
        viewBox="0 0 800 400"
        className="h-full w-full max-w-5xl"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M0 200 Q200 100 400 200 T800 200"
          stroke="#1612d3"
          strokeWidth="2"
          fill="none"
        />
        <path
          d="M0 250 Q200 350 400 250 T800 250"
          stroke="#1612d3"
          strokeWidth="1.5"
          fill="none"
        />
        <circle cx="400" cy="200" r="40" stroke="#1612d3" strokeWidth="2" />
        <circle cx="250" cy="150" r="24" stroke="#1612d3" strokeWidth="1.5" />
        <circle cx="550" cy="150" r="24" stroke="#1612d3" strokeWidth="1.5" />
        <circle cx="200" cy="280" r="20" stroke="#1612d3" strokeWidth="1.5" />
        <circle cx="600" cy="280" r="20" stroke="#1612d3" strokeWidth="1.5" />
        <line x1="400" y1="200" x2="250" y2="150" stroke="#1612d3" strokeWidth="1" />
        <line x1="400" y1="200" x2="550" y2="150" stroke="#1612d3" strokeWidth="1" />
        <line x1="400" y1="200" x2="200" y2="280" stroke="#1612d3" strokeWidth="1" />
        <line x1="400" y1="200" x2="600" y2="280" stroke="#1612d3" strokeWidth="1" />
      </svg>
    </div>
  );
}
