import Image from "next/image";
import Link from "next/link";
import { cn } from "@/lib/utils";

type BrandLogoProps = {
  alt: string;
  href?: string;
  className?: string;
  size?: "sm" | "md";
  tone?: "default" | "white";
};

export function BrandLogo({ alt, href, className, size = "md", tone = "default" }: BrandLogoProps) {
  const height = size === "sm" ? 52 : 68;

  const img = (
    <Image
      src={`/brand/kod-bzh/logos/kod-bzh-h${tone === "white" ? "-white" : ""}.png`}
      alt={alt}
      width={1220}
      height={660}
      style={{ height, width: "auto", maxWidth: "100%" }}
      className="object-contain object-left"
      priority
    />
  );

  if (href) {
    return (
      <Link
        href={href}
        className={cn(
          "inline-block rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-encre focus-visible:ring-offset-2",
          className
        )}
      >
        {img}
      </Link>
    );
  }

  return <div className={cn("inline-block", className)}>{img}</div>;
}
