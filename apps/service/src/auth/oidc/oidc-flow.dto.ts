import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

// base64url of 32 bytes, or of a sha256 digest.
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/;

export class OidcStartDto {
  /** base64url(sha256(binding)) — the binding itself never leaves the tab that started the flow. */
  @Matches(BASE64URL_32)
  binding_hash!: string;

  /** An org invite's token, carried from its link; accepted once the sign-in completes. */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  invite_token?: string;
}

export class OidcLinkStartDto {
  @Matches(BASE64URL_32)
  binding_hash!: string;

  /** The account's current password — required when it has one. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  current_password?: string;
}

export class OidcCompleteDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  code!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  state!: string;

  @Matches(BASE64URL_32)
  binding!: string;

  /** RFC 9207: the issuer the provider named in its authorization response. */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  iss?: string;
}
