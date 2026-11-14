const steps = [
  { name: "Import", detail: "Upload your Claude export. It is parsed in your browser." },
  { name: "Discover", detail: "Recall finds commitments and unfinished work, each with a quote." },
  { name: "Resume", detail: "Approve what matters and pick it back up with full context." },
];

export default function HomePage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-12 px-6 py-24">
      <header className="flex flex-col gap-5">
        <p className="font-mono text-xs tracking-widest text-muted-foreground uppercase">
          Recall
        </p>
        <h1 className="text-4xl leading-tight font-semibold tracking-tight text-balance sm:text-5xl">
          Your AI conversations remember what you discussed. Recall makes sure
          you do something about it.
        </h1>
        <p className="max-w-xl text-lg leading-relaxed text-muted-foreground">
          An execution workspace built from the conversations you have already
          had. No manual task entry.
        </p>
      </header>

      <ol className="grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-3">
        {steps.map((step, index) => (
          <li key={step.name} className="flex flex-col gap-2 bg-card p-5">
            <span className="font-mono text-xs text-muted-foreground">
              {String(index + 1).padStart(2, "0")}
            </span>
            <h2 className="text-sm font-semibold">{step.name}</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {step.detail}
            </p>
          </li>
        ))}
      </ol>

      <p className="text-sm text-muted-foreground">
        In development. Sign-in arrives with the next milestone.
      </p>
    </main>
  );
}
