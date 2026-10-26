import type { Metadata } from "next";
import { kodAssoUrl } from "@/lib/solution-urls";
import { notFound, redirect } from "next/navigation";
import { SolutionAccessPage, type SolutionAccessParams } from "@/components/auth/solution-access-page";
import { getSolutionKey } from "@/lib/solution-access";

type PageProps = {
  params: Promise<{ solution: string }>;
  searchParams: Promise<SolutionAccessParams>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const solution = getSolutionKey((await params).solution);
  if (!solution) return {};
  const name = solution === "mail" ? "Kod Mail" : "Kod Asso";
  return { title: `${name} — Votre espace | Kod BZH` };
}

export default async function SolutionPage({ params, searchParams }: PageProps) {
  const slug = (await params).solution;
  if (slug === "asso") redirect(kodAssoUrl());
  const solution = getSolutionKey(slug);
  if (!solution) notFound();
  const query = await searchParams;
  return <SolutionAccessPage solution={solution} mode={query.mode === "signup" ? "signup" : "login"} params={query} />;
}
