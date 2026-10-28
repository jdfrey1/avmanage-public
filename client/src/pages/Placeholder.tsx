export function Placeholder({ title }: { title: string }) {
  return (
    <div className="flex h-[60vh] flex-col items-center justify-center gap-2 text-center">
      <p className="text-lg font-medium">{title}</p>
      <p className="text-sm text-muted-foreground">Coming soon</p>
    </div>
  )
}
