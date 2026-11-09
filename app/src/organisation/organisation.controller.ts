import { Body, Controller, Get, Headers, HttpCode, NotFoundException, Param, Post, Put, Req, Res } from '@nestjs/common';
import { BeforeSetup, Public, RequireAction } from '../auth/access';
import type { HttpRequest } from '../auth/auth.guard';
import { type LogoImage, OrganisationProfileService, logoShape } from './organisation.service';

const field = (body: unknown, name: string): unknown => (body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined);
const actor = (req: HttpRequest): string => {
  const userId = req.auth?.user.id;
  if (!userId) throw new NotFoundException();
  return userId;
};

type ImageResponse = { status(code: number): ImageResponse; setHeader(name: string, value: string): void; end(body?: Buffer): void };

/** Sends a logo with its version as the validator; the browser asks again each time and gets 304 when unchanged. */
function sendImage(res: ImageResponse, image: LogoImage, ifNoneMatch: string | undefined): void {
  const etag = `"${image.version}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'no-cache');
  if (ifNoneMatch === etag) {
    res.status(304).end();
    return;
  }
  res.setHeader('Content-Type', image.mime);
  res.status(200).end(image.content);
}

/** The organisation's name, setup and logos. Open before setup: this is where setup happens. */
@BeforeSetup()
@Controller('organisation')
export class OrganisationProfileController {
  constructor(private readonly organisation: OrganisationProfileService) {}

  @Get()
  @RequireAction('organisation.manage')
  async get() {
    return this.organisation.get();
  }

  @Post('name')
  @HttpCode(200)
  @RequireAction('organisation.manage')
  async setName(@Body() body: unknown, @Req() req: HttpRequest) {
    return this.organisation.setName(field(body, 'name'), actor(req));
  }

  @Post('finish')
  @HttpCode(200)
  @RequireAction('organisation.manage')
  async finish(@Req() req: HttpRequest) {
    return this.organisation.finish(actor(req));
  }

  /** The body is the PNG or JPEG file itself. */
  @Put('logos/:shape')
  @RequireAction('organisation.manage')
  async uploadLogo(@Param('shape') shape: string, @Body() body: unknown, @Req() req: HttpRequest) {
    return this.organisation.uploadLogo(logoShape(shape), body, actor(req));
  }

  @Post('logos/:shape/remove')
  @HttpCode(200)
  @RequireAction('organisation.manage')
  async removeLogo(@Param('shape') shape: string, @Req() req: HttpRequest) {
    return this.organisation.removeLogo(logoShape(shape), actor(req));
  }

  @Get('logos/:shape/preview')
  @RequireAction('organisation.manage')
  async preview(@Param('shape') shape: string, @Headers('if-none-match') inm: string | undefined, @Res() res: ImageResponse) {
    sendImage(res, await this.organisation.preview(logoShape(shape)), inm);
  }

  @Get('branding')
  @Public()
  async branding() {
    return this.organisation.branding();
  }

  @Get('logo/:shape')
  @Public()
  async logo(@Param('shape') shape: string, @Headers('if-none-match') inm: string | undefined, @Res() res: ImageResponse) {
    sendImage(res, await this.organisation.logoInUse(logoShape(shape)), inm);
  }
}
