"use client";
import dynamic from "next/dynamic";

const CampusWorld = dynamic(() => import("@/components/CampusWorld"), { ssr: false });

export default function CampusPage() {
  return <CampusWorld />;
}
