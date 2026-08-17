// The boot preset (fuse & filter demo): R and G merge, fusion produces RG
// and releases heat, the budded filter splits singles from composites.
import { finish, launch, ok } from './helpers.mjs';

const d = await launch();
const { pause, ticks, worldInfo } = d;

await pause();
{
  const info = await worldInfo();
  ok('demo boots with two fed veins + organ', info.veins.length >= 2 && info.organs.length === 1);
  ok('sources attached', info.veins.filter((v) => v.head === 'source').length === 2);
}

await ticks(300);
{
  const info = await worldInfo();
  const all = {};
  for (const v of info.veins) for (const [s, n] of Object.entries(v.totals)) all[s] = (all[s] ?? 0) + n;
  ok('R and G flow', (all.R ?? 0) > 0 && (all.G ?? 0) > 0);
  ok('fusion produced RG', (all.RG ?? 0) > 1000);
  ok('fusion released heat (some parcel above ambient)', info.maxTemp > 1.05);
  // the organ eats the trunk's flow: the vein feeding it must end organ-in
  ok('trunk feeds the filter', info.veins.some((v) => v.tail === 'organ-in'));
}

await finish(d);
