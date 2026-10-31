/**
 * The drawing of each glyph of the section icon library. Each one is an icon of `lucide-solid`, which
 * the app already has, so the library adds no package. The editor and the section rail load this
 * module with `import()` when they need it (`features/sidebar/section-icon-assets.ts`), so it does not
 * add to the start of the app. It is an icon set, as `icons.ts` is, so it is in the primitive layer:
 * only that layer imports `lucide-solid`. The names and the search words are in
 * `features/sidebar/section-icon-library-data.ts`, which loads at the same time.
 */

import type { SidebarSectionGlyph } from "@openbot/contracts/ipc";
import AccessibilityIcon from "lucide-solid/icons/accessibility";
import ActivityIcon from "lucide-solid/icons/activity";
import AlarmClockIcon from "lucide-solid/icons/alarm-clock";
import AlbumIcon from "lucide-solid/icons/album";
import AnchorIcon from "lucide-solid/icons/anchor";
import AntennaIcon from "lucide-solid/icons/antenna";
import ApertureIcon from "lucide-solid/icons/aperture";
import AppWindowIcon from "lucide-solid/icons/app-window";
import AppleIcon from "lucide-solid/icons/apple";
import ArchiveIcon from "lucide-solid/icons/archive";
import ArmchairIcon from "lucide-solid/icons/armchair";
import AtSignIcon from "lucide-solid/icons/at-sign";
import AtomIcon from "lucide-solid/icons/atom";
import AudioLinesIcon from "lucide-solid/icons/audio-lines";
import AwardIcon from "lucide-solid/icons/award";
import AxeIcon from "lucide-solid/icons/axe";
import BabyIcon from "lucide-solid/icons/baby";
import BackpackIcon from "lucide-solid/icons/backpack";
import BadgeCheckIcon from "lucide-solid/icons/badge-check";
import BadgeDollarSignIcon from "lucide-solid/icons/badge-dollar-sign";
import BadgePercentIcon from "lucide-solid/icons/badge-percent";
import BanIcon from "lucide-solid/icons/ban";
import BananaIcon from "lucide-solid/icons/banana";
import BanknoteIcon from "lucide-solid/icons/banknote";
import BarcodeIcon from "lucide-solid/icons/barcode";
import BathIcon from "lucide-solid/icons/bath";
import BatteryFullIcon from "lucide-solid/icons/battery-full";
import BedIcon from "lucide-solid/icons/bed";
import BeefIcon from "lucide-solid/icons/beef";
import BeerIcon from "lucide-solid/icons/beer";
import BellIcon from "lucide-solid/icons/bell";
import BellRingIcon from "lucide-solid/icons/bell-ring";
import BikeIcon from "lucide-solid/icons/bike";
import BinaryIcon from "lucide-solid/icons/binary";
import BirdIcon from "lucide-solid/icons/bird";
import BitcoinIcon from "lucide-solid/icons/bitcoin";
import BlocksIcon from "lucide-solid/icons/blocks";
import BombIcon from "lucide-solid/icons/bomb";
import BoneIcon from "lucide-solid/icons/bone";
import BookOpenIcon from "lucide-solid/icons/book-open";
import BookmarkIcon from "lucide-solid/icons/bookmark";
import BotIcon from "lucide-solid/icons/bot";
import BotMessageSquareIcon from "lucide-solid/icons/bot-message-square";
import BoxIcon from "lucide-solid/icons/box";
import BracesIcon from "lucide-solid/icons/braces";
import BracketsIcon from "lucide-solid/icons/brackets";
import BrainIcon from "lucide-solid/icons/brain";
import BrainCircuitIcon from "lucide-solid/icons/brain-circuit";
import BrainCogIcon from "lucide-solid/icons/brain-cog";
import BriefcaseIcon from "lucide-solid/icons/briefcase";
import BriefcaseBusinessIcon from "lucide-solid/icons/briefcase-business";
import BrushIcon from "lucide-solid/icons/brush";
import BugIcon from "lucide-solid/icons/bug";
import BuildingIcon from "lucide-solid/icons/building";
import Building2Icon from "lucide-solid/icons/building-2";
import BusIcon from "lucide-solid/icons/bus";
import CableIcon from "lucide-solid/icons/cable";
import CakeIcon from "lucide-solid/icons/cake";
import CakeSliceIcon from "lucide-solid/icons/cake-slice";
import CalculatorIcon from "lucide-solid/icons/calculator";
import CalendarIcon from "lucide-solid/icons/calendar";
import CalendarCheckIcon from "lucide-solid/icons/calendar-check";
import CameraIcon from "lucide-solid/icons/camera";
import CandyIcon from "lucide-solid/icons/candy";
import CarIcon from "lucide-solid/icons/car";
import CarTaxiFrontIcon from "lucide-solid/icons/car-taxi-front";
import CarrotIcon from "lucide-solid/icons/carrot";
import CastIcon from "lucide-solid/icons/cast";
import CastleIcon from "lucide-solid/icons/castle";
import CatIcon from "lucide-solid/icons/cat";
import ChartAreaIcon from "lucide-solid/icons/chart-area";
import ChartCandlestickIcon from "lucide-solid/icons/chart-candlestick";
import ChartColumnIcon from "lucide-solid/icons/chart-column";
import ChartLineIcon from "lucide-solid/icons/chart-line";
import ChartNetworkIcon from "lucide-solid/icons/chart-network";
import ChartPieIcon from "lucide-solid/icons/chart-pie";
import ChartScatterIcon from "lucide-solid/icons/chart-scatter";
import ChefHatIcon from "lucide-solid/icons/chef-hat";
import CherryIcon from "lucide-solid/icons/cherry";
import ChurchIcon from "lucide-solid/icons/church";
import CircleCheckIcon from "lucide-solid/icons/circle-check";
import CircleDollarSignIcon from "lucide-solid/icons/circle-dollar-sign";
import CircleParkingIcon from "lucide-solid/icons/circle-parking";
import CirclePlayIcon from "lucide-solid/icons/circle-play";
import CitrusIcon from "lucide-solid/icons/citrus";
import ClapperboardIcon from "lucide-solid/icons/clapperboard";
import ClipboardCheckIcon from "lucide-solid/icons/clipboard-check";
import ClipboardListIcon from "lucide-solid/icons/clipboard-list";
import ClockIcon from "lucide-solid/icons/clock";
import CloudIcon from "lucide-solid/icons/cloud";
import CloudCogIcon from "lucide-solid/icons/cloud-cog";
import CloudDownloadIcon from "lucide-solid/icons/cloud-download";
import CloudLightningIcon from "lucide-solid/icons/cloud-lightning";
import CloudRainIcon from "lucide-solid/icons/cloud-rain";
import CloudSunIcon from "lucide-solid/icons/cloud-sun";
import CloudUploadIcon from "lucide-solid/icons/cloud-upload";
import CloverIcon from "lucide-solid/icons/clover";
import CodeIcon from "lucide-solid/icons/code";
import CodeXmlIcon from "lucide-solid/icons/code-xml";
import CoffeeIcon from "lucide-solid/icons/coffee";
import CoinsIcon from "lucide-solid/icons/coins";
import CommandIcon from "lucide-solid/icons/command";
import CompassIcon from "lucide-solid/icons/compass";
import ComponentIcon from "lucide-solid/icons/component";
import ConstructionIcon from "lucide-solid/icons/construction";
import ContactRoundIcon from "lucide-solid/icons/contact-round";
import ContainerIcon from "lucide-solid/icons/container";
import CookieIcon from "lucide-solid/icons/cookie";
import CookingPotIcon from "lucide-solid/icons/cooking-pot";
import CpuIcon from "lucide-solid/icons/cpu";
import CreditCardIcon from "lucide-solid/icons/credit-card";
import CroissantIcon from "lucide-solid/icons/croissant";
import CrownIcon from "lucide-solid/icons/crown";
import CupSodaIcon from "lucide-solid/icons/cup-soda";
import DatabaseIcon from "lucide-solid/icons/database";
import DessertIcon from "lucide-solid/icons/dessert";
import Dice5Icon from "lucide-solid/icons/dice-5";
import Disc3Icon from "lucide-solid/icons/disc-3";
import DogIcon from "lucide-solid/icons/dog";
import DollarSignIcon from "lucide-solid/icons/dollar-sign";
import DonutIcon from "lucide-solid/icons/donut";
import DoorOpenIcon from "lucide-solid/icons/door-open";
import DownloadIcon from "lucide-solid/icons/download";
import DramaIcon from "lucide-solid/icons/drama";
import DroneIcon from "lucide-solid/icons/drone";
import DropletIcon from "lucide-solid/icons/droplet";
import DrumIcon from "lucide-solid/icons/drum";
import DrumstickIcon from "lucide-solid/icons/drumstick";
import DumbbellIcon from "lucide-solid/icons/dumbbell";
import EarIcon from "lucide-solid/icons/ear";
import EarthIcon from "lucide-solid/icons/earth";
import EggIcon from "lucide-solid/icons/egg";
import EggFriedIcon from "lucide-solid/icons/egg-fried";
import EraserIcon from "lucide-solid/icons/eraser";
import EuroIcon from "lucide-solid/icons/euro";
import EyeIcon from "lucide-solid/icons/eye";
import FaceAngryIcon from "lucide-solid/icons/face-angry";
import FaceGrinningIcon from "lucide-solid/icons/face-grinning";
import FaceSlightlyFrowningIcon from "lucide-solid/icons/face-slightly-frowning";
import FaceSlightlySmilingIcon from "lucide-solid/icons/face-slightly-smiling";
import FactoryIcon from "lucide-solid/icons/factory";
import FeatherIcon from "lucide-solid/icons/feather";
import FileCodeIcon from "lucide-solid/icons/file-code";
import FileDiffIcon from "lucide-solid/icons/file-diff";
import FileSpreadsheetIcon from "lucide-solid/icons/file-spreadsheet";
import FileTextIcon from "lucide-solid/icons/file-text";
import FilesIcon from "lucide-solid/icons/files";
import FilmIcon from "lucide-solid/icons/film";
import FingerprintPatternIcon from "lucide-solid/icons/fingerprint-pattern";
import FishIcon from "lucide-solid/icons/fish";
import FlagIcon from "lucide-solid/icons/flag";
import FlameIcon from "lucide-solid/icons/flame";
import FlashlightIcon from "lucide-solid/icons/flashlight";
import FlaskConicalIcon from "lucide-solid/icons/flask-conical";
import FlowerIcon from "lucide-solid/icons/flower";
import Flower2Icon from "lucide-solid/icons/flower-2";
import FolderIcon from "lucide-solid/icons/folder";
import FolderKanbanIcon from "lucide-solid/icons/folder-kanban";
import FolderOpenIcon from "lucide-solid/icons/folder-open";
import FootprintsIcon from "lucide-solid/icons/footprints";
import ForwardIcon from "lucide-solid/icons/forward";
import FuelIcon from "lucide-solid/icons/fuel";
import FunnelIcon from "lucide-solid/icons/funnel";
import Gamepad2Icon from "lucide-solid/icons/gamepad-2";
import GaugeIcon from "lucide-solid/icons/gauge";
import GavelIcon from "lucide-solid/icons/gavel";
import GemIcon from "lucide-solid/icons/gem";
import GhostIcon from "lucide-solid/icons/ghost";
import GiftIcon from "lucide-solid/icons/gift";
import GitBranchIcon from "lucide-solid/icons/git-branch";
import GitCommitHorizontalIcon from "lucide-solid/icons/git-commit-horizontal";
import GitCompareIcon from "lucide-solid/icons/git-compare";
import GitForkIcon from "lucide-solid/icons/git-fork";
import GitMergeIcon from "lucide-solid/icons/git-merge";
import GitPullRequestIcon from "lucide-solid/icons/git-pull-request";
import GlassWaterIcon from "lucide-solid/icons/glass-water";
import GlassesIcon from "lucide-solid/icons/glasses";
import GraduationCapIcon from "lucide-solid/icons/graduation-cap";
import GrapeIcon from "lucide-solid/icons/grape";
import GuitarIcon from "lucide-solid/icons/guitar";
import HamburgerIcon from "lucide-solid/icons/hamburger";
import HammerIcon from "lucide-solid/icons/hammer";
import HandIcon from "lucide-solid/icons/hand";
import HandCoinsIcon from "lucide-solid/icons/hand-coins";
import HandHeartIcon from "lucide-solid/icons/hand-heart";
import HandHelpingIcon from "lucide-solid/icons/hand-helping";
import HandshakeIcon from "lucide-solid/icons/handshake";
import HardDriveIcon from "lucide-solid/icons/hard-drive";
import HardHatIcon from "lucide-solid/icons/hard-hat";
import HashIcon from "lucide-solid/icons/hash";
import HeadphonesIcon from "lucide-solid/icons/headphones";
import HeadsetIcon from "lucide-solid/icons/headset";
import HeartIcon from "lucide-solid/icons/heart";
import HeartHandshakeIcon from "lucide-solid/icons/heart-handshake";
import HeartPulseIcon from "lucide-solid/icons/heart-pulse";
import HighlighterIcon from "lucide-solid/icons/highlighter";
import HotelIcon from "lucide-solid/icons/hotel";
import HourglassIcon from "lucide-solid/icons/hourglass";
import HouseIcon from "lucide-solid/icons/house";
import IceCreamConeIcon from "lucide-solid/icons/ice-cream-cone";
import IdCardIcon from "lucide-solid/icons/id-card";
import ImageIcon from "lucide-solid/icons/image";
import ImagesIcon from "lucide-solid/icons/images";
import InboxIcon from "lucide-solid/icons/inbox";
import InfinityIcon from "lucide-solid/icons/infinity";
import InfoIcon from "lucide-solid/icons/info";
import JoystickIcon from "lucide-solid/icons/joystick";
import KanbanIcon from "lucide-solid/icons/kanban";
import KeyIcon from "lucide-solid/icons/key";
import KeyRoundIcon from "lucide-solid/icons/key-round";
import KeyboardIcon from "lucide-solid/icons/keyboard";
import LampIcon from "lucide-solid/icons/lamp";
import LandmarkIcon from "lucide-solid/icons/landmark";
import LanguagesIcon from "lucide-solid/icons/languages";
import LaptopIcon from "lucide-solid/icons/laptop";
import LayersIcon from "lucide-solid/icons/layers";
import LayoutDashboardIcon from "lucide-solid/icons/layout-dashboard";
import LayoutTemplateIcon from "lucide-solid/icons/layout-template";
import LeafIcon from "lucide-solid/icons/leaf";
import LeafyGreenIcon from "lucide-solid/icons/leafy-green";
import LifeBuoyIcon from "lucide-solid/icons/life-buoy";
import LightbulbIcon from "lucide-solid/icons/lightbulb";
import LinkIcon from "lucide-solid/icons/link";
import ListIcon from "lucide-solid/icons/list";
import ListOrderedIcon from "lucide-solid/icons/list-ordered";
import ListTodoIcon from "lucide-solid/icons/list-todo";
import LockIcon from "lucide-solid/icons/lock";
import LockOpenIcon from "lucide-solid/icons/lock-open";
import LollipopIcon from "lucide-solid/icons/lollipop";
import LuggageIcon from "lucide-solid/icons/luggage";
import MagnetIcon from "lucide-solid/icons/magnet";
import MailIcon from "lucide-solid/icons/mail";
import MailCheckIcon from "lucide-solid/icons/mail-check";
import MailOpenIcon from "lucide-solid/icons/mail-open";
import MailboxIcon from "lucide-solid/icons/mailbox";
import MapIcon from "lucide-solid/icons/map";
import MapPinIcon from "lucide-solid/icons/map-pin";
import MartiniIcon from "lucide-solid/icons/martini";
import MedalIcon from "lucide-solid/icons/medal";
import MegaphoneIcon from "lucide-solid/icons/megaphone";
import MemoryStickIcon from "lucide-solid/icons/memory-stick";
import MessageCircleIcon from "lucide-solid/icons/message-circle";
import MessageCircleMoreIcon from "lucide-solid/icons/message-circle-more";
import MessageSquareIcon from "lucide-solid/icons/message-square";
import MessageSquareHeartIcon from "lucide-solid/icons/message-square-heart";
import MessagesSquareIcon from "lucide-solid/icons/messages-square";
import MicIcon from "lucide-solid/icons/mic";
import MicSignalIcon from "lucide-solid/icons/mic-signal";
import MicVocalIcon from "lucide-solid/icons/mic-vocal";
import MicrochipIcon from "lucide-solid/icons/microchip";
import MicroscopeIcon from "lucide-solid/icons/microscope";
import MilestoneIcon from "lucide-solid/icons/milestone";
import MilkIcon from "lucide-solid/icons/milk";
import MonitorIcon from "lucide-solid/icons/monitor";
import MoonIcon from "lucide-solid/icons/moon";
import MotorbikeIcon from "lucide-solid/icons/motorbike";
import MountainIcon from "lucide-solid/icons/mountain";
import MountainSnowIcon from "lucide-solid/icons/mountain-snow";
import MouseIcon from "lucide-solid/icons/mouse";
import MusicIcon from "lucide-solid/icons/music";
import NavigationIcon from "lucide-solid/icons/navigation";
import NetworkIcon from "lucide-solid/icons/network";
import NewspaperIcon from "lucide-solid/icons/newspaper";
import NotebookPenIcon from "lucide-solid/icons/notebook-pen";
import OrbitIcon from "lucide-solid/icons/orbit";
import OrigamiIcon from "lucide-solid/icons/origami";
import PackageIcon from "lucide-solid/icons/package";
import PackageCheckIcon from "lucide-solid/icons/package-check";
import PackageOpenIcon from "lucide-solid/icons/package-open";
import PaletteIcon from "lucide-solid/icons/palette";
import PandaIcon from "lucide-solid/icons/panda";
import PaperclipIcon from "lucide-solid/icons/paperclip";
import PartyPopperIcon from "lucide-solid/icons/party-popper";
import PawPrintIcon from "lucide-solid/icons/paw-print";
import PenToolIcon from "lucide-solid/icons/pen-tool";
import PencilIcon from "lucide-solid/icons/pencil";
import PercentIcon from "lucide-solid/icons/percent";
import PersonStandingIcon from "lucide-solid/icons/person-standing";
import PhoneIcon from "lucide-solid/icons/phone";
import PhoneCallIcon from "lucide-solid/icons/phone-call";
import PianoIcon from "lucide-solid/icons/piano";
import PiggyBankIcon from "lucide-solid/icons/piggy-bank";
import PillIcon from "lucide-solid/icons/pill";
import PinIcon from "lucide-solid/icons/pin";
import PizzaIcon from "lucide-solid/icons/pizza";
import PlaneIcon from "lucide-solid/icons/plane";
import PlayIcon from "lucide-solid/icons/play";
import PlugIcon from "lucide-solid/icons/plug";
import PopcornIcon from "lucide-solid/icons/popcorn";
import PopsicleIcon from "lucide-solid/icons/popsicle";
import PowerIcon from "lucide-solid/icons/power";
import PresentationIcon from "lucide-solid/icons/presentation";
import PrinterIcon from "lucide-solid/icons/printer";
import ProjectorIcon from "lucide-solid/icons/projector";
import PuzzleIcon from "lucide-solid/icons/puzzle";
import QrCodeIcon from "lucide-solid/icons/qr-code";
import QuoteIcon from "lucide-solid/icons/quote";
import RabbitIcon from "lucide-solid/icons/rabbit";
import RadarIcon from "lucide-solid/icons/radar";
import RadioIcon from "lucide-solid/icons/radio";
import RainbowIcon from "lucide-solid/icons/rainbow";
import RatIcon from "lucide-solid/icons/rat";
import ReceiptIcon from "lucide-solid/icons/receipt";
import RecycleIcon from "lucide-solid/icons/recycle";
import RefreshCwIcon from "lucide-solid/icons/refresh-cw";
import RegexIcon from "lucide-solid/icons/regex";
import RepeatIcon from "lucide-solid/icons/repeat";
import ReplyIcon from "lucide-solid/icons/reply";
import RocketIcon from "lucide-solid/icons/rocket";
import RotateCcwClockIcon from "lucide-solid/icons/rotate-ccw-clock";
import RouteIcon from "lucide-solid/icons/route";
import RssIcon from "lucide-solid/icons/rss";
import RulerIcon from "lucide-solid/icons/ruler";
import SailboatIcon from "lucide-solid/icons/sailboat";
import SaladIcon from "lucide-solid/icons/salad";
import SandwichIcon from "lucide-solid/icons/sandwich";
import SatelliteIcon from "lucide-solid/icons/satellite";
import SatelliteDishIcon from "lucide-solid/icons/satellite-dish";
import ScaleIcon from "lucide-solid/icons/scale";
import ScanFaceIcon from "lucide-solid/icons/scan-face";
import ScanTextIcon from "lucide-solid/icons/scan-text";
import SchoolIcon from "lucide-solid/icons/school";
import ScissorsIcon from "lucide-solid/icons/scissors";
import ScrollTextIcon from "lucide-solid/icons/scroll-text";
import SearchIcon from "lucide-solid/icons/search";
import SendIcon from "lucide-solid/icons/send";
import ServerIcon from "lucide-solid/icons/server";
import ServerCogIcon from "lucide-solid/icons/server-cog";
import SettingsIcon from "lucide-solid/icons/settings";
import ShapesIcon from "lucide-solid/icons/shapes";
import Share2Icon from "lucide-solid/icons/share-2";
import SheetIcon from "lucide-solid/icons/sheet";
import ShellIcon from "lucide-solid/icons/shell";
import ShieldAlertIcon from "lucide-solid/icons/shield-alert";
import ShieldCheckIcon from "lucide-solid/icons/shield-check";
import ShipIcon from "lucide-solid/icons/ship";
import ShirtIcon from "lucide-solid/icons/shirt";
import ShoppingBagIcon from "lucide-solid/icons/shopping-bag";
import ShoppingCartIcon from "lucide-solid/icons/shopping-cart";
import ShovelIcon from "lucide-solid/icons/shovel";
import ShrimpIcon from "lucide-solid/icons/shrimp";
import SigmaIcon from "lucide-solid/icons/sigma";
import SignatureIcon from "lucide-solid/icons/signature";
import SignpostIcon from "lucide-solid/icons/signpost";
import SlidersHorizontalIcon from "lucide-solid/icons/sliders-horizontal";
import SmartphoneIcon from "lucide-solid/icons/smartphone";
import SnailIcon from "lucide-solid/icons/snail";
import SnowflakeIcon from "lucide-solid/icons/snowflake";
import SofaIcon from "lucide-solid/icons/sofa";
import SoupIcon from "lucide-solid/icons/soup";
import SparkleIcon from "lucide-solid/icons/sparkle";
import SparklesIcon from "lucide-solid/icons/sparkles";
import SpeakerIcon from "lucide-solid/icons/speaker";
import SpeechIcon from "lucide-solid/icons/speech";
import SproutIcon from "lucide-solid/icons/sprout";
import SquareFunctionIcon from "lucide-solid/icons/square-function";
import SquarePlayIcon from "lucide-solid/icons/square-play";
import SquareTerminalIcon from "lucide-solid/icons/square-terminal";
import SquirrelIcon from "lucide-solid/icons/squirrel";
import StarIcon from "lucide-solid/icons/star";
import StethoscopeIcon from "lucide-solid/icons/stethoscope";
import StickyNoteIcon from "lucide-solid/icons/sticky-note";
import StoreIcon from "lucide-solid/icons/store";
import SunIcon from "lucide-solid/icons/sun";
import SunMoonIcon from "lucide-solid/icons/sun-moon";
import SunriseIcon from "lucide-solid/icons/sunrise";
import SunsetIcon from "lucide-solid/icons/sunset";
import SwordIcon from "lucide-solid/icons/sword";
import SwordsIcon from "lucide-solid/icons/swords";
import SyringeIcon from "lucide-solid/icons/syringe";
import TableIcon from "lucide-solid/icons/table";
import TabletIcon from "lucide-solid/icons/tablet";
import TagIcon from "lucide-solid/icons/tag";
import TagsIcon from "lucide-solid/icons/tags";
import TargetIcon from "lucide-solid/icons/target";
import TelescopeIcon from "lucide-solid/icons/telescope";
import TentIcon from "lucide-solid/icons/tent";
import TerminalIcon from "lucide-solid/icons/terminal";
import TestTubeIcon from "lucide-solid/icons/test-tube";
import TheaterIcon from "lucide-solid/icons/theater";
import ThermometerIcon from "lucide-solid/icons/thermometer";
import ThumbsUpIcon from "lucide-solid/icons/thumbs-up";
import TicketIcon from "lucide-solid/icons/ticket";
import TicketPercentIcon from "lucide-solid/icons/ticket-percent";
import TimerIcon from "lucide-solid/icons/timer";
import ToggleRightIcon from "lucide-solid/icons/toggle-right";
import TornadoIcon from "lucide-solid/icons/tornado";
import ToyBrickIcon from "lucide-solid/icons/toy-brick";
import TrafficConeIcon from "lucide-solid/icons/traffic-cone";
import TrainFrontIcon from "lucide-solid/icons/train-front";
import TramFrontIcon from "lucide-solid/icons/tram-front";
import Trash2Icon from "lucide-solid/icons/trash-2";
import TreeDeciduousIcon from "lucide-solid/icons/tree-deciduous";
import TreePalmIcon from "lucide-solid/icons/tree-palm";
import TreePineIcon from "lucide-solid/icons/tree-pine";
import TreesIcon from "lucide-solid/icons/trees";
import TrendingDownIcon from "lucide-solid/icons/trending-down";
import TrendingUpIcon from "lucide-solid/icons/trending-up";
import TriangleAlertIcon from "lucide-solid/icons/triangle-alert";
import TrophyIcon from "lucide-solid/icons/trophy";
import TruckIcon from "lucide-solid/icons/truck";
import TurtleIcon from "lucide-solid/icons/turtle";
import TvIcon from "lucide-solid/icons/tv";
import TypeIcon from "lucide-solid/icons/type";
import UmbrellaIcon from "lucide-solid/icons/umbrella";
import UnplugIcon from "lucide-solid/icons/unplug";
import UploadIcon from "lucide-solid/icons/upload";
import UserIcon from "lucide-solid/icons/user";
import UserCheckIcon from "lucide-solid/icons/user-check";
import UserCogIcon from "lucide-solid/icons/user-cog";
import UserPlusIcon from "lucide-solid/icons/user-plus";
import UserRoundIcon from "lucide-solid/icons/user-round";
import UsersRoundIcon from "lucide-solid/icons/users-round";
import UtensilsIcon from "lucide-solid/icons/utensils";
import VariableIcon from "lucide-solid/icons/variable";
import VeganIcon from "lucide-solid/icons/vegan";
import VenetianMaskIcon from "lucide-solid/icons/venetian-mask";
import VideoIcon from "lucide-solid/icons/video";
import Volume2Icon from "lucide-solid/icons/volume-2";
import WalletIcon from "lucide-solid/icons/wallet";
import WandSparklesIcon from "lucide-solid/icons/wand-sparkles";
import WarehouseIcon from "lucide-solid/icons/warehouse";
import WatchIcon from "lucide-solid/icons/watch";
import WavesHorizontalIcon from "lucide-solid/icons/waves-horizontal";
import WebcamIcon from "lucide-solid/icons/webcam";
import WebhookIcon from "lucide-solid/icons/webhook";
import WheatIcon from "lucide-solid/icons/wheat";
import WifiIcon from "lucide-solid/icons/wifi";
import WindIcon from "lucide-solid/icons/wind";
import WineIcon from "lucide-solid/icons/wine";
import WorkflowIcon from "lucide-solid/icons/workflow";
import WormIcon from "lucide-solid/icons/worm";
import WrenchIcon from "lucide-solid/icons/wrench";
import ZapIcon from "lucide-solid/icons/zap";

type GlyphIcon = typeof BotIcon;

export const SECTION_ICON_COMPONENTS = {
  bot: BotIcon,
  sparkles: SparklesIcon,
  shield: ShieldCheckIcon,
  code: CodeIcon,
  brain: BrainIcon,
  zap: ZapIcon,
  globe: EarthIcon,
  film: FilmIcon,
  camera: CameraIcon,
  megaphone: MegaphoneIcon,
  message: MessageCircleIcon,
  mail: MailIcon,
  users: UsersRoundIcon,
  crown: CrownIcon,
  gift: GiftIcon,
  palette: PaletteIcon,
  book: BookOpenIcon,
  folder: FolderIcon,
  cloud: CloudIcon,
  cpu: CpuIcon,
  lock: LockIcon,
  store: StoreIcon,
  chart: ChartAreaIcon,
  workflow: WorkflowIcon,
  home: HouseIcon,
  star: StarIcon,
  heart: HeartIcon,
  flag: FlagIcon,
  bookmark: BookmarkIcon,
  bell: BellIcon,
  pin: PinIcon,
  "map-pin": MapPinIcon,
  calendar: CalendarIcon,
  clock: ClockIcon,
  "alarm-clock": AlarmClockIcon,
  hourglass: HourglassIcon,
  timer: TimerIcon,
  search: SearchIcon,
  settings: SettingsIcon,
  "sliders-horizontal": SlidersHorizontalIcon,
  wrench: WrenchIcon,
  hammer: HammerIcon,
  lightbulb: LightbulbIcon,
  rocket: RocketIcon,
  target: TargetIcon,
  trophy: TrophyIcon,
  award: AwardIcon,
  medal: MedalIcon,
  gem: GemIcon,
  flame: FlameIcon,
  infinity: InfinityIcon,
  tag: TagIcon,
  tags: TagsIcon,
  inbox: InboxIcon,
  archive: ArchiveIcon,
  "trash-2": Trash2Icon,
  "circle-check": CircleCheckIcon,
  "list-todo": ListTodoIcon,
  "clipboard-list": ClipboardListIcon,
  "notebook-pen": NotebookPenIcon,
  "sticky-note": StickyNoteIcon,
  layers: LayersIcon,
  "layout-dashboard": LayoutDashboardIcon,
  puzzle: PuzzleIcon,
  blocks: BlocksIcon,
  box: BoxIcon,
  package: PackageIcon,
  key: KeyIcon,
  eye: EyeIcon,
  sparkle: SparkleIcon,
  "wand-sparkles": WandSparklesIcon,
  smile: FaceSlightlySmilingIcon,
  "thumbs-up": ThumbsUpIcon,
  "party-popper": PartyPopperIcon,
  info: InfoIcon,
  "triangle-alert": TriangleAlertIcon,
  ban: BanIcon,
  power: PowerIcon,
  "refresh-cw": RefreshCwIcon,
  repeat: RepeatIcon,
  activity: ActivityIcon,
  gauge: GaugeIcon,
  "toggle-right": ToggleRightIcon,
  link: LinkIcon,
  paperclip: PaperclipIcon,
  scissors: ScissorsIcon,
  pencil: PencilIcon,
  "pen-tool": PenToolIcon,
  brush: BrushIcon,
  eraser: EraserIcon,
  ruler: RulerIcon,
  highlighter: HighlighterIcon,
  terminal: TerminalIcon,
  "square-terminal": SquareTerminalIcon,
  "code-xml": CodeXmlIcon,
  braces: BracesIcon,
  brackets: BracketsIcon,
  "file-code": FileCodeIcon,
  "git-branch": GitBranchIcon,
  "git-commit-horizontal": GitCommitHorizontalIcon,
  "git-merge": GitMergeIcon,
  "git-pull-request": GitPullRequestIcon,
  "git-fork": GitForkIcon,
  "git-compare": GitCompareIcon,
  bug: BugIcon,
  server: ServerIcon,
  "server-cog": ServerCogIcon,
  "cloud-cog": CloudCogIcon,
  container: ContainerIcon,
  binary: BinaryIcon,
  variable: VariableIcon,
  "square-function": SquareFunctionIcon,
  regex: RegexIcon,
  webhook: WebhookIcon,
  "bot-message-square": BotMessageSquareIcon,
  microchip: MicrochipIcon,
  "memory-stick": MemoryStickIcon,
  "hard-drive": HardDriveIcon,
  "app-window": AppWindowIcon,
  component: ComponentIcon,
  "layout-template": LayoutTemplateIcon,
  network: NetworkIcon,
  plug: PlugIcon,
  unplug: UnplugIcon,
  cable: CableIcon,
  "shield-alert": ShieldAlertIcon,
  fingerprint: FingerprintPatternIcon,
  "key-round": KeyRoundIcon,
  "lock-open": LockOpenIcon,
  "scan-face": ScanFaceIcon,
  "test-tube": TestTubeIcon,
  "flask-conical": FlaskConicalIcon,
  atom: AtomIcon,
  sigma: SigmaIcon,
  hash: HashIcon,
  command: CommandIcon,
  "package-open": PackageOpenIcon,
  "file-diff": FileDiffIcon,
  radar: RadarIcon,
  "qr-code": QrCodeIcon,
  "message-square": MessageSquareIcon,
  "messages-square": MessagesSquareIcon,
  "message-circle-more": MessageCircleMoreIcon,
  send: SendIcon,
  "mail-open": MailOpenIcon,
  phone: PhoneIcon,
  "phone-call": PhoneCallIcon,
  video: VideoIcon,
  mic: MicIcon,
  headphones: HeadphonesIcon,
  headset: HeadsetIcon,
  speaker: SpeakerIcon,
  "volume-2": Volume2Icon,
  radio: RadioIcon,
  podcast: MicSignalIcon,
  rss: RssIcon,
  newspaper: NewspaperIcon,
  "at-sign": AtSignIcon,
  "share-2": Share2Icon,
  wifi: WifiIcon,
  "satellite-dish": SatelliteDishIcon,
  satellite: SatelliteIcon,
  antenna: AntennaIcon,
  "bell-ring": BellRingIcon,
  languages: LanguagesIcon,
  speech: SpeechIcon,
  quote: QuoteIcon,
  "message-square-heart": MessageSquareHeartIcon,
  reply: ReplyIcon,
  forward: ForwardIcon,
  mailbox: MailboxIcon,
  "mail-check": MailCheckIcon,
  database: DatabaseIcon,
  table: TableIcon,
  sheet: SheetIcon,
  "chart-column": ChartColumnIcon,
  "chart-line": ChartLineIcon,
  "chart-pie": ChartPieIcon,
  "chart-scatter": ChartScatterIcon,
  "chart-candlestick": ChartCandlestickIcon,
  "chart-network": ChartNetworkIcon,
  "trending-up": TrendingUpIcon,
  "trending-down": TrendingDownIcon,
  presentation: PresentationIcon,
  "file-spreadsheet": FileSpreadsheetIcon,
  "file-text": FileTextIcon,
  files: FilesIcon,
  "folder-open": FolderOpenIcon,
  "folder-kanban": FolderKanbanIcon,
  kanban: KanbanIcon,
  list: ListIcon,
  "list-ordered": ListOrderedIcon,
  funnel: FunnelIcon,
  calculator: CalculatorIcon,
  percent: PercentIcon,
  history: RotateCcwClockIcon,
  milestone: MilestoneIcon,
  "scroll-text": ScrollTextIcon,
  "clipboard-check": ClipboardCheckIcon,
  "scan-text": ScanTextIcon,
  "brain-circuit": BrainCircuitIcon,
  "brain-cog": BrainCogIcon,
  orbit: OrbitIcon,
  download: DownloadIcon,
  upload: UploadIcon,
  "cloud-download": CloudDownloadIcon,
  "cloud-upload": CloudUploadIcon,
  user: UserIcon,
  "user-round": UserRoundIcon,
  "user-plus": UserPlusIcon,
  "user-check": UserCheckIcon,
  "user-cog": UserCogIcon,
  "contact-round": ContactRoundIcon,
  "id-card": IdCardIcon,
  baby: BabyIcon,
  "person-standing": PersonStandingIcon,
  accessibility: AccessibilityIcon,
  hand: HandIcon,
  "hand-heart": HandHeartIcon,
  "hand-helping": HandHelpingIcon,
  handshake: HandshakeIcon,
  "heart-handshake": HeartHandshakeIcon,
  laugh: FaceGrinningIcon,
  frown: FaceSlightlyFrowningIcon,
  angry: FaceAngryIcon,
  "graduation-cap": GraduationCapIcon,
  school: SchoolIcon,
  briefcase: BriefcaseIcon,
  glasses: GlassesIcon,
  ear: EarIcon,
  "venetian-mask": VenetianMaskIcon,
  ghost: GhostIcon,
  dumbbell: DumbbellIcon,
  "heart-pulse": HeartPulseIcon,
  stethoscope: StethoscopeIcon,
  pill: PillIcon,
  syringe: SyringeIcon,
  footprints: FootprintsIcon,
  laptop: LaptopIcon,
  monitor: MonitorIcon,
  smartphone: SmartphoneIcon,
  tablet: TabletIcon,
  keyboard: KeyboardIcon,
  mouse: MouseIcon,
  printer: PrinterIcon,
  watch: WatchIcon,
  "battery-full": BatteryFullIcon,
  lamp: LampIcon,
  armchair: ArmchairIcon,
  bed: BedIcon,
  sofa: SofaIcon,
  bath: BathIcon,
  "door-open": DoorOpenIcon,
  umbrella: UmbrellaIcon,
  backpack: BackpackIcon,
  flashlight: FlashlightIcon,
  magnet: MagnetIcon,
  telescope: TelescopeIcon,
  microscope: MicroscopeIcon,
  shovel: ShovelIcon,
  axe: AxeIcon,
  construction: ConstructionIcon,
  "hard-hat": HardHatIcon,
  bomb: BombIcon,
  sword: SwordIcon,
  swords: SwordsIcon,
  "toy-brick": ToyBrickIcon,
  shirt: ShirtIcon,
  ticket: TicketIcon,
  "gamepad-2": Gamepad2Icon,
  joystick: JoystickIcon,
  "dice-5": Dice5Icon,
  sun: SunIcon,
  moon: MoonIcon,
  "sun-moon": SunMoonIcon,
  "cloud-sun": CloudSunIcon,
  "cloud-rain": CloudRainIcon,
  "cloud-lightning": CloudLightningIcon,
  snowflake: SnowflakeIcon,
  wind: WindIcon,
  tornado: TornadoIcon,
  rainbow: RainbowIcon,
  droplet: DropletIcon,
  waves: WavesHorizontalIcon,
  mountain: MountainIcon,
  "mountain-snow": MountainSnowIcon,
  trees: TreesIcon,
  "tree-deciduous": TreeDeciduousIcon,
  "tree-pine": TreePineIcon,
  "tree-palm": TreePalmIcon,
  leaf: LeafIcon,
  sprout: SproutIcon,
  flower: FlowerIcon,
  "flower-2": Flower2Icon,
  clover: CloverIcon,
  shell: ShellIcon,
  sunrise: SunriseIcon,
  sunset: SunsetIcon,
  thermometer: ThermometerIcon,
  recycle: RecycleIcon,
  bird: BirdIcon,
  cat: CatIcon,
  dog: DogIcon,
  fish: FishIcon,
  rabbit: RabbitIcon,
  turtle: TurtleIcon,
  squirrel: SquirrelIcon,
  snail: SnailIcon,
  rat: RatIcon,
  worm: WormIcon,
  panda: PandaIcon,
  "paw-print": PawPrintIcon,
  feather: FeatherIcon,
  bone: BoneIcon,
  origami: OrigamiIcon,
  coffee: CoffeeIcon,
  "cup-soda": CupSodaIcon,
  "glass-water": GlassWaterIcon,
  beer: BeerIcon,
  wine: WineIcon,
  martini: MartiniIcon,
  milk: MilkIcon,
  pizza: PizzaIcon,
  hamburger: HamburgerIcon,
  sandwich: SandwichIcon,
  salad: SaladIcon,
  soup: SoupIcon,
  utensils: UtensilsIcon,
  "chef-hat": ChefHatIcon,
  "cooking-pot": CookingPotIcon,
  apple: AppleIcon,
  banana: BananaIcon,
  cherry: CherryIcon,
  citrus: CitrusIcon,
  grape: GrapeIcon,
  carrot: CarrotIcon,
  "leafy-green": LeafyGreenIcon,
  croissant: CroissantIcon,
  cake: CakeIcon,
  "cake-slice": CakeSliceIcon,
  cookie: CookieIcon,
  donut: DonutIcon,
  dessert: DessertIcon,
  "ice-cream-cone": IceCreamConeIcon,
  popsicle: PopsicleIcon,
  lollipop: LollipopIcon,
  candy: CandyIcon,
  popcorn: PopcornIcon,
  egg: EggIcon,
  "egg-fried": EggFriedIcon,
  beef: BeefIcon,
  drumstick: DrumstickIcon,
  shrimp: ShrimpIcon,
  wheat: WheatIcon,
  vegan: VeganIcon,
  music: MusicIcon,
  "audio-lines": AudioLinesIcon,
  play: PlayIcon,
  "circle-play": CirclePlayIcon,
  "square-play": SquarePlayIcon,
  clapperboard: ClapperboardIcon,
  image: ImageIcon,
  images: ImagesIcon,
  aperture: ApertureIcon,
  tv: TvIcon,
  cast: CastIcon,
  webcam: WebcamIcon,
  projector: ProjectorIcon,
  album: AlbumIcon,
  "disc-3": Disc3Icon,
  "mic-vocal": MicVocalIcon,
  guitar: GuitarIcon,
  drum: DrumIcon,
  piano: PianoIcon,
  theater: TheaterIcon,
  drama: DramaIcon,
  type: TypeIcon,
  shapes: ShapesIcon,
  "briefcase-business": BriefcaseBusinessIcon,
  "building-2": Building2Icon,
  building: BuildingIcon,
  factory: FactoryIcon,
  landmark: LandmarkIcon,
  "shopping-cart": ShoppingCartIcon,
  "shopping-bag": ShoppingBagIcon,
  wallet: WalletIcon,
  "credit-card": CreditCardIcon,
  banknote: BanknoteIcon,
  coins: CoinsIcon,
  "piggy-bank": PiggyBankIcon,
  "dollar-sign": DollarSignIcon,
  "circle-dollar-sign": CircleDollarSignIcon,
  euro: EuroIcon,
  bitcoin: BitcoinIcon,
  "hand-coins": HandCoinsIcon,
  receipt: ReceiptIcon,
  "badge-percent": BadgePercentIcon,
  "badge-check": BadgeCheckIcon,
  "badge-dollar-sign": BadgeDollarSignIcon,
  "ticket-percent": TicketPercentIcon,
  "calendar-check": CalendarCheckIcon,
  signature: SignatureIcon,
  scale: ScaleIcon,
  gavel: GavelIcon,
  barcode: BarcodeIcon,
  truck: TruckIcon,
  "package-check": PackageCheckIcon,
  warehouse: WarehouseIcon,
  plane: PlaneIcon,
  car: CarIcon,
  "car-taxi-front": CarTaxiFrontIcon,
  bus: BusIcon,
  "train-front": TrainFrontIcon,
  "tram-front": TramFrontIcon,
  ship: ShipIcon,
  sailboat: SailboatIcon,
  bike: BikeIcon,
  motorbike: MotorbikeIcon,
  drone: DroneIcon,
  fuel: FuelIcon,
  map: MapIcon,
  navigation: NavigationIcon,
  compass: CompassIcon,
  route: RouteIcon,
  signpost: SignpostIcon,
  tent: TentIcon,
  hotel: HotelIcon,
  luggage: LuggageIcon,
  castle: CastleIcon,
  church: ChurchIcon,
  "traffic-cone": TrafficConeIcon,
  anchor: AnchorIcon,
  "life-buoy": LifeBuoyIcon,
  "circle-parking": CircleParkingIcon,
} as const satisfies Record<SidebarSectionGlyph, GlyphIcon>;
