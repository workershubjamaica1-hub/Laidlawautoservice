// vehicleCatalog.js — makes and models common in Jamaica, grouped by vehicle type.
// Customers search this list when they add a vehicle. If theirs is not here they can add it themselves (they pick the type),
// so this list does not have to be perfect. Add or change entries freely; keep one "Make Model" per line.
module.exports = {
  cars: [
    // Toyota
    "Toyota Corolla", "Toyota Axio", "Toyota Fielder", "Toyota Allion", "Toyota Premio", "Toyota Camry", "Toyota Yaris", "Toyota Vitz",
    "Toyota Aqua", "Toyota Prius", "Toyota Passo", "Toyota Auris", "Toyota Avensis", "Toyota Altezza", "Toyota Mark X", "Toyota Crown",
    "Toyota Corona", "Toyota Carina", "Toyota Starlet", "Toyota Echo", "Toyota Platz", "Toyota Belta", "Toyota Ist", "Toyota Probox",
    "Toyota Succeed", "Toyota Sai", "Toyota Wish", "Toyota Sienta", "Toyota Ractis", "Toyota Blade", "Toyota Celica", "Toyota Supra", "Toyota 86",
    // Honda
    "Honda Civic", "Honda Accord", "Honda Fit", "Honda City", "Honda Insight", "Honda Stream", "Honda Freed", "Honda Airwave", "Honda Integra",
    "Honda Legend", "Honda Prelude", "Honda S2000", "Honda CR-Z", "Honda Grace", "Honda Shuttle", "Honda Jazz",
    // Nissan
    "Nissan Tiida", "Nissan Sunny", "Nissan Note", "Nissan March", "Nissan Micra", "Nissan Almera", "Nissan Latio", "Nissan Sylphy", "Nissan Bluebird",
    "Nissan Teana", "Nissan Maxima", "Nissan Altima", "Nissan Cube", "Nissan Wingroad", "Nissan AD Wagon", "Nissan Skyline", "Nissan Fuga", "Nissan Cefiro",
    "Nissan Primera", "Nissan Pulsar", "Nissan Leaf", "Nissan Silvia", "Nissan 350Z", "Nissan Versa", "Nissan Sentra",
    // Suzuki
    "Suzuki Swift", "Suzuki Alto", "Suzuki Wagon R", "Suzuki Splash", "Suzuki Baleno", "Suzuki Celerio", "Suzuki Ignis", "Suzuki Dzire", "Suzuki SX4", "Suzuki Cultus",
    // Hyundai and Kia
    "Hyundai Accent", "Hyundai Elantra", "Hyundai Sonata", "Hyundai i10", "Hyundai i20", "Hyundai i30", "Hyundai Getz", "Hyundai Verna", "Hyundai Veloster", "Hyundai Grandeur",
    "Kia Picanto", "Kia Rio", "Kia Cerato", "Kia Forte", "Kia Optima", "Kia Soul", "Kia Spectra", "Kia Morning", "Kia K5",
    // Mazda
    "Mazda 2", "Mazda 3", "Mazda 6", "Mazda Demio", "Mazda Axela", "Mazda Atenza", "Mazda Premacy", "Mazda Familia", "Mazda RX-8", "Mazda MX-5",
    // Mitsubishi and Subaru
    "Mitsubishi Lancer", "Mitsubishi Mirage", "Mitsubishi Colt", "Mitsubishi Galant", "Mitsubishi Eclipse", "Mitsubishi Attrage", "Mitsubishi Evolution",
    "Subaru Impreza", "Subaru Legacy", "Subaru WRX", "Subaru BRZ",
    // Daihatsu and other Japanese
    "Daihatsu Mira", "Daihatsu Move", "Daihatsu Charade", "Daihatsu Sirion", "Daihatsu Cuore", "Isuzu Gemini", "Lexus IS", "Lexus ES", "Lexus GS", "Lexus LS", "Lexus CT", "Lexus RC", "Infiniti G35", "Infiniti Q50", "Acura TL", "Acura ILX",
    // European
    "BMW 1 Series", "BMW 3 Series", "BMW 5 Series", "BMW 7 Series", "BMW Z4", "BMW i3", "BMW M3",
    "Mercedes-Benz A-Class", "Mercedes-Benz B-Class", "Mercedes-Benz C-Class", "Mercedes-Benz E-Class", "Mercedes-Benz S-Class", "Mercedes-Benz CLA", "Mercedes-Benz CLK", "Mercedes-Benz SLK",
    "Audi A3", "Audi A4", "Audi A5", "Audi A6", "Audi A8", "Audi TT",
    "Volkswagen Golf", "Volkswagen Polo", "Volkswagen Jetta", "Volkswagen Passat", "Volkswagen Beetle", "Volkswagen Bora", "Volkswagen Vento", "Volkswagen Scirocco",
    "Peugeot 206", "Peugeot 207", "Peugeot 208", "Peugeot 307", "Peugeot 308", "Peugeot 407", "Peugeot 508", "Renault Clio", "Renault Megane", "Renault Logan", "Renault Fluence",
    "Volvo S40", "Volvo S60", "Volvo S80", "Volvo V40", "Opel Astra", "Opel Corsa", "Opel Vectra", "Fiat 500", "Fiat Punto", "Fiat Palio", "Skoda Octavia", "Skoda Fabia", "Seat Ibiza", "Seat Leon",
    "Mini Cooper", "Jaguar XF", "Jaguar XE", "Jaguar XJ", "Jaguar S-Type", "Alfa Romeo Giulia", "Alfa Romeo 147",
    // American
    "Ford Focus", "Ford Fiesta", "Ford Fusion", "Ford Taurus", "Ford Mustang", "Ford Escort", "Ford Mondeo", "Ford Ka", "Ford Crown Victoria",
    "Chevrolet Cruze", "Chevrolet Spark", "Chevrolet Aveo", "Chevrolet Malibu", "Chevrolet Camaro", "Chevrolet Cobalt", "Chevrolet Impala", "Chevrolet Sonic", "Chevrolet Optra",
    "Dodge Charger", "Dodge Challenger", "Dodge Neon", "Dodge Avenger", "Dodge Dart", "Chrysler 300", "Chrysler Sebring", "Pontiac Grand Prix", "Buick LaCrosse", "Cadillac CTS", "Lincoln Town Car", "Tesla Model 3", "Tesla Model S",
    // Chinese and Korean others
    "Chery QQ", "Chery Tiggo", "BYD F3", "BYD Han", "Geely Emgrand", "MG 3", "MG 5", "Haval H6", "Great Wall Wingle", "Proton Saga", "Perodua Myvi", "SsangYong Actyon", "Daewoo Matiz"
  ],
  suvs: [
    "Toyota RAV4", "Toyota Highlander", "Toyota Land Cruiser", "Toyota Land Cruiser Prado", "Toyota Fortuner", "Toyota Harrier", "Toyota C-HR", "Toyota Rush", "Toyota Vanguard", "Toyota Kluger", "Toyota 4Runner", "Toyota Sequoia", "Toyota Venza", "Toyota Corolla Cross", "Toyota Raize",
    "Honda CR-V", "Honda HR-V", "Honda Vezel", "Honda Pilot", "Honda Element", "Honda BR-V", "Honda Passport",
    "Nissan X-Trail", "Nissan Juke", "Nissan Qashqai", "Nissan Murano", "Nissan Rogue", "Nissan Kicks", "Nissan Pathfinder", "Nissan Patrol", "Nissan Terrano", "Nissan Dualis", "Nissan Xterra", "Nissan Armada",
    "Suzuki Vitara", "Suzuki Grand Vitara", "Suzuki Jimny", "Suzuki Escudo", "Suzuki S-Cross", "Suzuki Ertiga", "Suzuki XL7", "Suzuki Ignis Cross",
    "Hyundai Tucson", "Hyundai Santa Fe", "Hyundai Creta", "Hyundai Kona", "Hyundai ix35", "Hyundai Palisade", "Hyundai Venue",
    "Kia Sportage", "Kia Sorento", "Kia Seltos", "Kia Sonet", "Kia Carens", "Kia Telluride",
    "Mazda CX-3", "Mazda CX-5", "Mazda CX-7", "Mazda CX-9", "Mazda CX-30", "Mazda Tribute",
    "Mitsubishi Outlander", "Mitsubishi ASX", "Mitsubishi Pajero", "Mitsubishi Pajero Sport", "Mitsubishi Montero", "Mitsubishi Eclipse Cross", "Mitsubishi Xpander", "Mitsubishi Delica",
    "Subaru Forester", "Subaru XV", "Subaru Outback", "Subaru Crosstrek", "Subaru Ascent",
    "Lexus RX", "Lexus NX", "Lexus GX", "Lexus LX", "Lexus UX", "Infiniti QX60", "Infiniti FX35", "Acura MDX", "Acura RDX",
    "BMW X1", "BMW X2", "BMW X3", "BMW X4", "BMW X5", "BMW X6", "BMW X7",
    "Mercedes-Benz GLA", "Mercedes-Benz GLB", "Mercedes-Benz GLC", "Mercedes-Benz GLE", "Mercedes-Benz GLS", "Mercedes-Benz ML", "Mercedes-Benz G-Class",
    "Audi Q2", "Audi Q3", "Audi Q5", "Audi Q7", "Audi Q8", "Volkswagen Tiguan", "Volkswagen Touareg", "Volkswagen T-Roc", "Volvo XC40", "Volvo XC60", "Volvo XC90",
    "Land Rover Range Rover", "Land Rover Range Rover Sport", "Land Rover Range Rover Evoque", "Land Rover Discovery", "Land Rover Defender", "Land Rover Freelander", "Jaguar F-Pace", "Porsche Cayenne", "Porsche Macan",
    "Ford Escape", "Ford Explorer", "Ford Edge", "Ford EcoSport", "Ford Expedition", "Ford Bronco", "Ford Everest", "Ford Kuga", "Ford Territory",
    "Chevrolet Trax", "Chevrolet Equinox", "Chevrolet Tahoe", "Chevrolet Suburban", "Chevrolet Captiva", "Chevrolet Traverse", "Chevrolet Blazer",
    "Jeep Wrangler", "Jeep Grand Cherokee", "Jeep Cherokee", "Jeep Compass", "Jeep Renegade", "Jeep Patriot", "Jeep Liberty", "Dodge Journey", "Dodge Durango", "GMC Yukon", "GMC Terrain", "GMC Acadia", "Cadillac Escalade", "Lincoln Navigator",
    "Peugeot 2008", "Peugeot 3008", "Peugeot 5008", "Renault Duster", "Renault Koleos", "Renault Captur", "Isuzu MU-X", "Daihatsu Terios", "Daihatsu Rocky", "Daihatsu Bego",
    "Chery Tiggo 7", "Haval H2", "Haval Jolion", "MG ZS", "MG HS", "BYD Atto 3", "BYD Tang", "Geely Coolray", "Tesla Model X", "Tesla Model Y", "Great Wall Haval", "Mahindra Scorpio", "Mahindra XUV500", "Tata Safari"
  ],
  vans: [
    "Toyota Hiace", "Toyota Hiace Commuter", "Toyota Noah", "Toyota Voxy", "Toyota Alphard", "Toyota Vellfire", "Toyota Estima", "Toyota Previa", "Toyota Sienna", "Toyota Townace", "Toyota Liteace", "Toyota Regius", "Toyota Granvia", "Toyota Probox Van", "Toyota Hiace Super Grandia",
    "Nissan Serena", "Nissan Caravan", "Nissan NV350", "Nissan NV200", "Nissan Vanette", "Nissan Elgrand", "Nissan Primastar", "Nissan Urvan", "Nissan Clipper", "Nissan Liberty",
    "Honda Odyssey", "Honda Stepwgn", "Honda Elysion", "Honda N-Box", "Honda Mobilio", "Honda Acty Van",
    "Mazda Bongo", "Mazda MPV", "Mazda Biante", "Mazda Premacy Van", "Mitsubishi Delica Van", "Mitsubishi Express", "Mitsubishi L300", "Mitsubishi Grandis",
    "Suzuki Every", "Suzuki Carry Van", "Suzuki APV", "Daihatsu Hijet", "Daihatsu Atrai", "Subaru Sambar", "Subaru Exiga",
    "Hyundai H-1", "Hyundai Starex", "Hyundai H100 Van", "Kia Carnival", "Kia Sedona", "Kia Pregio", "Kia K2500 Van",
    "Ford Transit", "Ford Transit Connect", "Ford Econoline", "Ford E-Series", "Ford Tourneo", "Chevrolet Express", "Chevrolet Astro", "Chevrolet City Express", "GMC Savana", "Dodge Grand Caravan", "Dodge Ram Van", "Chrysler Town & Country", "Chrysler Pacifica",
    "Mercedes-Benz Sprinter", "Mercedes-Benz Vito", "Mercedes-Benz V-Class", "Volkswagen Transporter", "Volkswagen Caddy", "Volkswagen Crafter", "Volkswagen Multivan", "Renault Trafic", "Renault Master", "Renault Kangoo",
    "Peugeot Partner", "Peugeot Expert", "Peugeot Boxer", "Citroen Berlingo", "Citroen Jumper", "Fiat Ducato", "Fiat Doblo", "Iveco Daily", "Opel Vivaro", "Isuzu Elf Van", "Foton View", "Jinbei Haise", "JMC Transit"
  ],
  buses: [
    "Toyota Coaster", "Nissan Civilian", "Nissan Caravan Bus", "Mitsubishi Rosa", "Hino Liesse", "Hino Poncho", "Isuzu Journey", "Isuzu Gala", "Isuzu Erga", "Hyundai County", "Hyundai Universe", "Hyundai Aero",
    "Mercedes-Benz Sprinter Bus", "Mercedes-Benz Tourismo", "Mercedes-Benz Citaro", "Volvo B7R", "Volvo B9R", "Scania K-Series", "Scania Marcopolo", "MAN Lion's Coach", "Marcopolo Paradiso", "Yutong ZK6", "Yutong Bus", "King Long Bus", "Higer Bus", "Golden Dragon Bus", "Zhongtong Bus",
    "Blue Bird Vision", "Thomas Built Saf-T-Liner", "International School Bus", "Ford E-450 Bus", "Chevrolet Express Bus", "Eicher Skyline", "Ashok Leyland Viking", "Tata Starbus", "Mahindra Tourister", "Toyota Hiace Mini Bus", "Foton Minibus"
  ],
  motorcycles: [
    "Honda CG 125", "Honda CB 125", "Honda CBR 250", "Honda CBR 600", "Honda CBR 1000", "Honda XR 150", "Honda CRF 250", "Honda Wave", "Honda PCX", "Honda Click", "Honda Dio", "Honda Activa", "Honda Africa Twin", "Honda Gold Wing", "Honda Shadow",
    "Yamaha YBR 125", "Yamaha FZ", "Yamaha R15", "Yamaha R1", "Yamaha R6", "Yamaha MT-07", "Yamaha XTZ 125", "Yamaha Crux", "Yamaha NMAX", "Yamaha Aerox", "Yamaha Virago", "Yamaha V Star",
    "Suzuki GN 125", "Suzuki GSX-R", "Suzuki GSX 150", "Suzuki Gixxer", "Suzuki Hayabusa", "Suzuki DR 200", "Suzuki Address", "Suzuki Burgman", "Suzuki Intruder",
    "Kawasaki Ninja 250", "Kawasaki Ninja 400", "Kawasaki Ninja ZX-6R", "Kawasaki Ninja ZX-10R", "Kawasaki KLX", "Kawasaki Z900", "Kawasaki Vulcan",
    "Bajaj Pulsar", "Bajaj Boxer", "Bajaj Discover", "Bajaj Avenger", "TVS Apache", "TVS Star", "Hero Splendor", "Hero Hunk", "Hero Passion", "Royal Enfield Classic", "Royal Enfield Bullet", "Royal Enfield Himalayan",
    "Harley-Davidson Sportster", "Harley-Davidson Softail", "Harley-Davidson Street Glide", "Harley-Davidson Fat Boy", "Ducati Monster", "Ducati Panigale", "BMW R1200GS", "BMW S1000RR", "KTM Duke", "KTM Adventure", "Triumph Bonneville", "Triumph Street Triple",
    "Vespa Primavera", "Vespa GTS", "Piaggio Liberty", "SYM Symphony", "Kymco Agility", "Lifan Motorcycle", "Haojue Motorcycle", "Zongshen Motorcycle", "Jincheng Motorcycle", "Can-Am Ryker", "Polaris Ranger", "Polaris Sportsman", "Honda Pioneer", "Yamaha Grizzly"
  ],
  lightTrucks: [
    "Toyota Hilux", "Toyota Tacoma", "Toyota Tundra", "Toyota Hilux Surf", "Toyota Tacoma Double Cab",
    "Ford Ranger", "Ford F-150", "Ford F-250", "Ford Courier", "Ford Maverick",
    "Isuzu D-Max", "Isuzu KB", "Isuzu Pickup",
    "Nissan Frontier", "Nissan Navara", "Nissan NP300", "Nissan Hardbody", "Nissan Titan",
    "Mitsubishi L200", "Mitsubishi Triton", "Mitsubishi Strada",
    "Mazda BT-50", "Mazda B2500", "Mazda B-Series", "Chevrolet Colorado", "Chevrolet Silverado", "Chevrolet S10", "Chevrolet Montana", "GMC Sierra", "GMC Canyon",
    "Dodge Ram 1500", "Dodge Dakota", "Ram 1500", "Ram 2500", "Honda Ridgeline", "Volkswagen Amarok", "Volkswagen Saveiro", "Renault Alaskan", "Great Wall Wingle 5", "Great Wall Wingle 7", "Foton Tunland", "JAC T6", "JAC T8", "Jinbei T5", "Mahindra Pik Up", "Mahindra Scorpio Getaway", "Tata Xenon", "Tata Yodha", "Changan Hunter", "Zotye Pickup", "SsangYong Musso", "Kia K2700", "Kia Bongo", "Suzuki Carry", "Daihatsu Hijet Truck", "Subaru Sambar Truck", "Mitsubishi Minicab Truck"
  ],
  smallTrucks: [
    "Isuzu ELF", "Isuzu NPR", "Isuzu NKR", "Isuzu NHR", "Isuzu NLR", "Isuzu N-Series", "Isuzu FTR Light",
    "Hino Dutro", "Hino 300", "Hino 195", "Hino Ranger", "Hino 500 Light",
    "Mitsubishi Canter", "Mitsubishi Fuso Canter", "Mitsubishi Fuso FE", "Mitsubishi L300 Truck",
    "Nissan Atlas", "Nissan Condor", "Nissan Cabstar", "Nissan Diesel Condor", "UD 1400",
    "Toyota Dyna", "Toyota Toyoace", "Toyota Hino Dutro", "Toyota Stout", "Mazda Titan", "Mazda T3500", "Mazda Bongo Truck",
    "Hyundai Porter", "Hyundai H100", "Hyundai Mighty", "Hyundai HD65", "Hyundai HD72", "Hyundai HD78", "Kia Frontier", "Kia K3000", "Kia Bongo III",
    "Foton Aumark", "Foton Ollin", "Foton Forland", "JAC Truck", "JAC 1040", "JMC Truck", "Dongfeng Captain", "Dongfeng Truck", "FAW Truck", "Sinotruk Howo Light", "Jinbei Truck", "Shacman Light", "Yuejin Truck", "Isuzu Forward Light",
    "Ford Cargo 815", "Ford F-350", "Ford F-450", "Ford F-550", "Chevrolet NPR", "Chevrolet W4500", "GMC W-Series", "Dodge Ram 3500", "Ram 3500", "Ram 4500", "Ram 5500", "International 4300", "Freightliner M2 106", "Mercedes-Benz Atego", "Mercedes-Benz Vario", "Iveco Eurocargo", "Iveco Daily Truck", "MAN TGL", "Renault Midlum", "Tata 407", "Tata 709", "Mahindra Furio", "Mahindra Bolero Pickup"
  ],
  heavyTrucks: [
    "Freightliner Cascadia", "Freightliner Columbia", "Freightliner Coronado", "Freightliner FLD", "Freightliner Century",
    "Kenworth T680", "Kenworth T800", "Kenworth T880", "Kenworth W900", "Kenworth T370", "Kenworth K100",
    "Peterbilt 579", "Peterbilt 389", "Peterbilt 367", "Peterbilt 567", "Mack Granite", "Mack Pinnacle", "Mack Anthem", "Mack CH", "Mack Titan",
    "International LT", "International ProStar", "International 9400", "International 7600", "International HX", "Western Star 4900", "Western Star 5700", "Sterling Truck",
    "Volvo FH", "Volvo FM", "Volvo FMX", "Volvo FL", "Volvo VNL", "Volvo VHD", "Scania R-Series", "Scania G-Series", "Scania P-Series", "Scania S-Series",
    "MAN TGX", "MAN TGS", "MAN TGM", "MAN F2000", "Mercedes-Benz Actros", "Mercedes-Benz Axor", "Mercedes-Benz Arocs", "Mercedes-Benz 2640", "Iveco Stralis", "Iveco Trakker", "Iveco Eurotech", "DAF XF", "DAF CF", "DAF LF", "Renault Premium", "Renault Magnum", "Renault T",
    "Isuzu FTR", "Isuzu FVR", "Isuzu FVZ", "Isuzu Giga", "Isuzu CXZ", "Isuzu EXR", "Isuzu Forward", "Isuzu 6X4",
    "Hino 500", "Hino 700", "Hino Profia", "Hino FM", "Hino FL", "Hino GH", "Hino Ranger Heavy",
    "Mitsubishi Fuso Fighter", "Mitsubishi Fuso Super Great", "Mitsubishi Fuso Shogun", "Mitsubishi Fuso FV", "Mitsubishi Fuso FP", "Mitsubishi Fuso FK",
    "Nissan Diesel Quon", "UD Quester", "UD Quon", "UD Condor Heavy", "Nissan CW", "Nissan Big Thumb",
    "Sinotruk Howo", "Sinotruk Sitrak", "Shacman F3000", "Shacman X3000", "Shacman Delong", "FAW J6", "FAW Jiefang", "Foton Auman", "Dongfeng Tianlong", "Dongfeng Kinland", "Beiben Truck", "XCMG Truck", "Faw Tipper", "Howo Tipper", "Howo Dump Truck",
    "Tata Prima", "Tata LPT", "Ashok Leyland Truck", "Ashok Leyland Boss", "BharatBenz Truck", "Mahindra Blazo", "Volvo Dump Truck", "Mack Dump Truck", "Kenworth Dump Truck", "International Dump Truck", "Isuzu Tipper", "Hino Tipper",
    "Cement Truck", "Concrete Mixer", "Garbage Truck", "Tanker Truck", "Water Truck", "Flatbed Truck", "Wrecker Truck", "Tow Truck", "Box Truck", "Refrigerated Truck", "Crane Truck", "Fire Truck",
    "Caterpillar 740", "Caterpillar Wheel Loader", "Caterpillar Excavator", "Caterpillar Backhoe", "Caterpillar Bulldozer", "Komatsu Excavator", "Komatsu Bulldozer", "Komatsu Wheel Loader", "Komatsu Dump Truck", "JCB Backhoe", "JCB 3CX", "JCB Excavator", "JCB Telehandler",
    "Volvo Excavator", "Volvo Wheel Loader", "Hitachi Excavator", "Doosan Excavator", "Hyundai Excavator", "Kobelco Excavator", "Case Backhoe", "Case Loader", "New Holland Tractor", "John Deere Tractor", "Massey Ferguson Tractor", "Kubota Tractor", "Mahindra Tractor", "Ford Tractor", "Bobcat Skid Steer", "Bobcat Loader", "Forklift"
  ]
};
