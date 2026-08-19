import { readFileSync } from 'node:fs';

import { Body, Controller, Logger, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { InjectDataSource } from '@nestjs/typeorm';
import { ArrayMaxSize, IsArray, IsString } from 'class-validator';
import { In, type DataSource } from 'typeorm';

import { AuthGuard } from '../auth/auth.guard';
import { errorMessage } from '../common/error-message';
import { dataFile } from '../generation/data-dir';
import { now } from '../database/ids';
import { NodeIconEntity } from '../database/entities/node-icon.entity';
import { Scope } from '../auth/scope.decorator';

class BatchDto {
  // Capped to bound the `node_icons` lookup and the response payload.
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  node_types!: string[];
}

/**
 * Node-icon resolver: `node_icons` cache → the app logo for a `<slug>.<action>` type. Icons are
 * self-hosted inline SVGs — no external fetch; anything without a logo resolves to null.
 */
@Controller('api')
@UseGuards(AuthGuard)
export class IconsController {
  private readonly logger = new Logger(IconsController.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Scope('workflow:read')
  @Post('node-icons/batch')
  async batch(@Body() body: BatchDto): Promise<{ icons: Record<string, string | null> }> {
    const result: Record<string, string | null> = {};
    const uncached: string[] = [];
    const em = this.dataSource.manager;

    if (body.node_types.length > 0) {
      const cached = await em.find(NodeIconEntity, { where: { nodeType: In(body.node_types) } });
      const byType = new Map(cached.map((c) => [c.nodeType, c.svg]));
      for (const nodeType of body.node_types) {
        if (byType.has(nodeType)) result[nodeType] = byType.get(nodeType) ?? null;
        else uncached.push(nodeType);
      }
    }

    const toPersist: NodeIconEntity[] = [];
    for (const nodeType of uncached) {
      const raw = this.orchestrIconSvg(nodeType);
      const svg = raw ? this.normalizeSvg(raw) : null;
      if (svg) toPersist.push(em.create(NodeIconEntity, { nodeType, svg, source: 'app', createdAt: now() }));
      result[nodeType] = svg;
    }

    if (toPersist.length > 0) {
      try {
        await em.save(NodeIconEntity, toPersist);
      } catch (err) {
        // Fail-open: the icons are already in the response; only the cache write was lost.
        this.logger.warn(`Failed to cache ${toPersist.length} node icons: ${errorMessage(err)}`);
      }
    }
    return { icons: result };
  }

  /** The self-hosted inline app-logo SVG for a built-in-engine action type, or null. */
  private orchestrIconSvg(nodeType: string): string | null {
    if (nodeType.startsWith('orchestr:')) return null; // control nodes have no app logo
    const dot = nodeType.indexOf('.');
    if (dot <= 0) return null;
    const svg = loadAppIcons(this.logger)[nodeType.slice(0, dot)];
    return typeof svg === 'string' && svg ? svg : null;
  }

  /** Ensure viewBox + strip fixed width/height so CSS controls sizing. */
  private normalizeSvg(svg: string): string {
    if (/viewBox/i.test(svg)) {
      return svg.replace(/\s+width="[^"]*"/, '').replace(/\s+height="[^"]*"/, '');
    }
    const w = /width="([^"]*)"/.exec(svg);
    const h = /height="([^"]*)"/.exec(svg);
    if (w && h) {
      const wv = w[1]!.replace('px', '').trim();
      const hv = h[1]!.replace('px', '').trim();
      return svg
        .replace(/(<svg\b)/, `$1 viewBox="0 0 ${wv} ${hv}"`)
        .replace(/\s+width="[^"]*"/, '')
        .replace(/\s+height="[^"]*"/, '');
    }
    return svg;
  }
}

// App logos (data/app-icons.json, slug → inline SVG); regenerate via scripts/build-icons.mjs.
let orchestrIconsCache: Record<string, unknown> | null = null;

function loadAppIcons(logger: Logger): Record<string, unknown> {
  if (orchestrIconsCache) return orchestrIconsCache;
  try {
    const path = dataFile(__dirname, 'app-icons.json');
    if (!path) logger.warn('app-icons.json not found — every node resolves to a null icon');
    orchestrIconsCache = path ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : {};
  } catch (err) {
    logger.warn(`Could not load app-icons.json: ${errorMessage(err)}`);
    orchestrIconsCache = {};
  }
  return orchestrIconsCache;
}
