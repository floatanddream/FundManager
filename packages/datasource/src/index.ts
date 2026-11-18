export { BusinessCodeError, DataSourceError, HttpError, ParseError } from './http/errors.ts'
export { decodeBody } from './http/encoding.ts'
export { HttpClient } from './http/client.ts'
export type { HttpClientOptions, HttpRequestSpec, HttpResponse } from './http/client.ts'
export type { CacheEntry, CacheStore } from './cache/cacheStore.ts'
export { MemoryCacheStore } from './cache/memoryCache.ts'
export {
  cwzbRequest,
  fhggRequest,
  hypzRequest,
  jjhslRequest,
  jjggRequest,
  lsjzRequest,
  parseCwzb,
  parseFhgg,
  parseHypz,
  parseJjhsl,
  parseJjgg,
  parseLsjz,
} from './endpoints/f10.ts'
export type {
  Announcement,
  AnnouncementPage,
  FinancialPeriod,
  FinancialReport,
  IndustryAllocationRow,
  IndustryQuarter,
  LsjzQuery,
  NavEvent,
  NavEventKind,
  NavPage,
  NavRow,
  TurnoverPage,
  TurnoverRow,
} from './endpoints/f10.ts'
export { parsePingzhongdata, pingzhongdataRequest } from './endpoints/pingzhongdata.ts'
export type {
  AccNavTrendPoint,
  CategorizedSeries,
  FundManager,
  GrandTotalSeries,
  IntervalReturns,
  NamedSeries,
  NavTrendPoint,
  PeerPercentPoint,
  PeerRankPoint,
  PerformanceEvaluation,
  Pingzhongdata,
  ScalePoint,
  StockPositionPoint,
} from './endpoints/pingzhongdata.ts'
export { gmbdRequest, jjccRequest, parseGmbd, parseJjcc } from './endpoints/fundArchives.ts'
export type {
  GmbdQuery,
  HoldingPeriod,
  HoldingRow,
  JjccQuery,
  ScaleShareRow,
} from './endpoints/fundArchives.ts'
export { fhspRequest, jbgkRequest, parseFhsp, parseJbgk } from './endpoints/htmlPages.ts'
export type {
  DividendRecord,
  DividendSplitPage,
  FundProfilePage,
  SplitRecord,
} from './endpoints/htmlPages.ts'
export {
  decodeGtimgBody,
  fqklineRequest,
  parseFqkline,
  parseQt,
  qtRequest,
} from './endpoints/gtimg.ts'
export type {
  DailyKline,
  FqklineQuery,
  KlineBar,
  Quote,
  QuoteLevel,
  QuoteTimestamp,
} from './endpoints/gtimg.ts'
export {
  clistRequest,
  parseSectorMembers,
  parseStockIndustry,
  stockRequest,
} from './endpoints/push2.ts'
export type { ClistQuery, SectorMember, SectorMembers, StockIndustry } from './endpoints/push2.ts'
export { fundcodeRequest, parseFundCodeList } from './endpoints/fundcode.ts'
export type { FundCodeEntry } from './endpoints/fundcode.ts'
export { createFundDataSource } from './capabilities/index.ts'
export { fetchWithFallback } from './capabilities/fetchWithFallback.ts'
export type {
  FallbackRun,
  FallbackSource,
  FetchWithFallbackSpec,
} from './capabilities/fetchWithFallback.ts'
export type {
  Fetched,
  FundDataSource,
  NavHistory,
  NavHistoryRow,
  ScaleHistory,
  ScaleHistoryRow,
  TurnoverResult,
} from './capabilities/types.ts'
