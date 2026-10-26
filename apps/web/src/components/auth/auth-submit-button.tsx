"use client";

import { useFormStatus } from "react-dom";
import { LoaderCircle, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

export function AuthSubmitButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="h-12 w-full justify-between px-5 text-sm">
      {pending ? pendingLabel : label}
      {pending ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <ArrowRight className="size-4" aria-hidden />}
    </Button>
  );
}
