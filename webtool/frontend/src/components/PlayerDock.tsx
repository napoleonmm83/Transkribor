export function PlayerDock({ children }: { children?: React.ReactNode }) {
  return <footer className="border-t px-3 py-2">{children ?? <div className="h-[72px]" />}</footer>
}
