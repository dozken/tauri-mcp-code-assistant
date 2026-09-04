import { IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';

export class IndexRequestDto {
  /** Absolute path to a local folder. */
  @IsString()
  @IsNotEmpty()
  path!: string;
}

export class SearchRequestDto {
  @IsString()
  @IsNotEmpty()
  query!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @IsOptional()
  @IsString()
  root?: string;
}
